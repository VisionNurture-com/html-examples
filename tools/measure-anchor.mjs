/**
 * measure-anchor.mjs — ページ内リンクが「どこへ飛ぶか」「どこに着地するか」を測る
 *
 * 使い方:
 *   node tools/measure-anchor.mjs
 *   node tools/measure-anchor.mjs --engine firefox
 *   node tools/measure-anchor.mjs --out tools/results/002-anchor.json
 *
 * 測るもの: symptoms/002-anchor-id/ の 3 本について
 *   ① 同じ id が複数あるとき、#name はどちらへ飛ぶか（見出しの文字列で特定する）
 *   ② 飛んだ直後、その見出しが固定ヘッダーに隠れているか（getBoundingClientRect().top と
 *      ヘッダーの高さを比べる。「隠れている」を目視でなく数値で判定する）
 *   ③ id に日本語を使ったとき、書いたままのリンクとエンコードしたリンクで結果が変わるか
 *
 * 🔴 「飛んだ / 飛ばない」を scrollY だけで判定しない。
 *   scrollY が動いても、目的の見出しがヘッダーの下にあれば読者には「飛んでいない」と見える。
 *   到達した要素の識別と、その要素の画面上の位置を分けて記録する。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'symptoms/002-anchor-id';
const CASES = [
  { file: 'broken.html', link: 'a[href="#plan"]', label: 'id が重複したページ（#plan）' },
  { file: 'broken.html', link: 'a[href="#support"]', label: 'id は一意だが固定ヘッダーがあるページ（#support）' },
  { file: 'fixed.html', link: 'a[href="#plan-detail"]', label: 'id を一意にしたページ（#plan-detail）' },
  { file: 'fixed.html', link: 'a[href="#support"]', label: 'scroll-margin-top を付けたページ（#support）' },
  { file: 'japanese-id.html', link: '#link-raw', label: '日本語の id へ、書いたまま書いたリンク' },
  { file: 'japanese-id.html', link: '#link-encoded', label: '日本語の id へ、エンコードして書いたリンク' }
];

/**
 * 追加ケース（--set extra で選ぶ）。既定の CASES には混ぜない。
 * 混ぜると 002-anchor.json のレコード数が変わり、過去の記録との差分照合ができなくなる。
 *
 * 測るもの: 飛び先の余白を「飛び先の要素側（section[id] の scroll-margin-top）」ではなく
 *   「スクロールする側（html の scroll-padding-top）」で確保したときに、着地位置が同じになるか。
 *   scroll-padding.html と fixed.html の差は CSS 1 行だけで、他の条件はそろえてある。
 */
const EXTRA_CASES = [
  { file: 'scroll-padding.html', link: 'a[href="#plan-detail"]', label: 'scroll-padding-top を付けたページ（#plan-detail）' },
  { file: 'scroll-padding.html', link: 'a[href="#support"]', label: 'scroll-padding-top を付けたページ（#support）' }
];

const CASE_SETS = { default: CASES, extra: EXTRA_CASES };

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null, set: 'default' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--set') { opts.set = argv[i + 1]; i += 1; }
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  if (!CASE_SETS[opts.set]) throw new Error(`unknown case set: ${opts.set}`);
  return opts;
}

function startServer() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0]));
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const opts = parseArgs(process.argv.slice(2));
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  for (const c of CASE_SETS[opts.set]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(base + c.file, { waitUntil: 'load' });

    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.click(c.link);
    await page.waitForTimeout(400);

    const result = await page.evaluate(() => {
      const hash = decodeURIComponent(location.hash.slice(1));
      // 同じ id が複数あるとき、どちらが「一致した要素」になったか（文書順で何番目か）
      const all = [...document.querySelectorAll('[id]')].filter((el) => el.id === hash);
      const target = document.getElementById(hash);
      const index = all.indexOf(target);
      const header = document.querySelector('header');
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      const rect = target ? target.getBoundingClientRect() : null;
      const heading = target?.querySelector('h1,h2,h3')?.textContent?.trim() ?? target?.textContent?.trim().slice(0, 20) ?? null;
      return {
        hash,
        matchedElementCount: all.length,
        matchedIndexInDocument: index,
        headingOfTarget: heading,
        scrollY: window.scrollY,
        targetTop: rect ? Math.round(rect.top) : null,
        headerHeight: Math.round(headerHeight),
        // 見出しがヘッダーの下に潜っているか。0 未満なら画面外、ヘッダー高より小さいなら隠れている
        hiddenBehindHeader: rect ? Math.round(rect.top) < Math.round(headerHeight) : null,
        // ページ内リンクを踏んだあと、フォーカスがどこに載っているか。
        // 踏んだリンク自身に残るのか、飛び先へ移るのかを区別する（2026-07-30 追加）。
        focusAfterClick: (() => {
          const el = document.activeElement;
          if (!el || el === document.body) return { tag: 'BODY', id: null, isTarget: false, note: 'フォーカスは body のまま' };
          return {
            tag: el.tagName,
            id: el.id || null,
            href: el.getAttribute ? el.getAttribute('href') : null,
            isTarget: target ? el === target : false,
            isClickedLink: el.tagName === 'A'
          };
        })()
      };
    });

    // キーボード経路でも測る（2026-07-30 追加）。
    // 上の測定は page.click() = マウス経路。キーボードの読者はリンクにフォーカスを載せて Enter で起動するため、
    // 飛んだ先へフォーカスが移るかどうかは経路によって変わりうる。両方を記録して区別する。
    const probeFocus = () => {
      const hash = decodeURIComponent(location.hash.slice(1));
      const target = document.getElementById(hash);
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', id: null, isTarget: false, note: 'フォーカスは body のまま' };
      return {
        tag: el.tagName,
        id: el.id || null,
        href: el.getAttribute ? el.getAttribute('href') : null,
        isTarget: target ? el === target : false,
        isClickedLink: el.tagName === 'A'
      };
    };
    await page.goto(base + c.file, { waitUntil: 'load' });
    await page.focus(c.link);
    const focusBeforeEnter = await page.evaluate(probeFocus);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const focusAfterKeyboardActivation = await page.evaluate(probeFocus);
    // 飛んだ「あと」に Tab を 1 回押すと、どこへ移るか。
    // 飛び先の続きから移動が始まるのか、文書の先頭に戻るのかを区別する（連続フォーカスの起点）。
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    const focusAfterNextTab = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', id: null };
      return { tag: el.tagName, id: el.id || null, href: el.getAttribute ? el.getAttribute('href') : null, text: (el.textContent || '').trim().slice(0, 24) };
    });

    records.push({ engine: engineName, browserVersion: browser.version(), file: c.file, link: c.link, label: c.label, scrollBefore, ...result, focusBeforeEnter, focusAfterKeyboardActivation, focusAfterNextTab });
    console.log(`[${engineName}] ${c.label}`);
    console.log(`  一致した要素: ${result.matchedElementCount} 個中 ${result.matchedIndexInDocument + 1} 番目 → 「${result.headingOfTarget}」`);
    console.log(`  scrollY: ${scrollBefore} → ${result.scrollY} / 見出しの上端: ${result.targetTop}px / ヘッダー高: ${result.headerHeight}px / 隠れている: ${result.hiddenBehindHeader}`);
    await context.close();
  }
  await browser.close();
}

server.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-anchor.mjs', root: ROOT, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
