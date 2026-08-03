/**
 * measure-click-target.mjs — 「押しても何も起きない」の原因を、クリックの届き先で切り分ける
 *
 * 使い方:
 *   node tools/measure-click-target.mjs
 *   node tools/measure-click-target.mjs --engine webkit
 *   node tools/measure-click-target.mjs --out tools/results/002-click-target.json
 *
 * 測るもの: symptoms/002-no-action/ の 4 本について
 *   ① そのリンクを押すと移動するか（URL の変化）
 *   ② クリックが実際に届いた要素は何か（要素の中心座標で elementFromPoint を引く）
 *   ③ click イベントが発火したか、既定動作が打ち消されたか（defaultPrevented）
 *
 * 検証する主張（いずれも競合上位が原因として挙げるもの・実機で確かめる）:
 *   - 「a タグの周りに全角スペースが入るとリンクと判断されない」
 *   - 「z-index が低いと a タグが反応しない」
 *   - 「button に href を書けば遷移する」
 *
 * 🔴 「移動しない」だけでは原因が分かれない。
 *   届いた要素・イベントの発火・既定動作の打ち消しを分けて記録し、
 *   「クリックが別の要素に吸われている」のか「届いてはいるが止められている」のかを見分ける。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'symptoms/002-no-action';
const CASES = [
  { file: 'button-href.html', id: 'broken', label: 'button に href を書いた' },
  { file: 'button-href.html', id: 'fixed', label: '同じ用途を a で書いた' },
  { file: 'prevented.html', id: 'inside', label: '親要素のハンドラが打ち消す位置のリンク' },
  { file: 'prevented.html', id: 'outside', label: '同じリンク（打ち消しの外）' },
  { file: 'overlay.html', id: 'covered', label: '透明な要素が上に重なったリンク' },
  { file: 'overlay.html', id: 'uncovered', label: '同じリンク（重なりの外）' },
  { file: 'fullwidth-space.html', id: 'plain', label: '① 通常' },
  { file: 'fullwidth-space.html', id: 'around', label: '② タグの前後に全角スペース' },
  { file: 'fullwidth-space.html', id: 'inside', label: '③ リンクテキストの中に全角スペース' },
  { file: 'fullwidth-space.html', id: 'attr', label: '④ 属性値の前に全角スペース' }
];

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
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
  for (const c of CASES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(base + c.file, { waitUntil: 'load' });

    // クリックの届き先と、リンクの解決先を先に記録する
    const before = await page.evaluate((id) => {
      const el = document.getElementById(id);
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      window.__events = [];
      document.addEventListener('click', (event) => {
        window.__events.push({ target: event.target.id || event.target.tagName, defaultPrevented: event.defaultPrevented });
      }, true);
      // capture では既定動作の打ち消し前に走るため、bubble 側でも記録する
      document.addEventListener('click', (event) => {
        window.__events.push({ phase: 'bubble', target: event.target.id || event.target.tagName, defaultPrevented: event.defaultPrevented });
      });
      return {
        tag: el.tagName.toLowerCase(),
        hrefAttr: el.getAttribute('href'),
        resolvedHref: el.href ?? null,
        hitElement: hit ? (hit.id || hit.className || hit.tagName) : null,
        hitIsTarget: hit === el || el.contains(hit)
      };
    }, c.id);

    const urlBefore = page.url();
    // 重なりがあってもマウスの位置に対して押す（要素の上へ強制的に届かせない）
    await page.locator(`#${c.id}`).click({ force: true, trial: false }).catch(() => {});
    await page.waitForTimeout(300);
    const urlAfter = page.url();
    const events = await page.evaluate(() => window.__events ?? []).catch(() => []);

    const record = {
      engine: engineName,
      browserVersion: browser.version(),
      file: c.file,
      id: c.id,
      label: c.label,
      ...before,
      navigated: urlBefore !== urlAfter,
      urlAfter,
      events
    };
    records.push(record);
    console.log(`[${engineName}] ${c.file} — ${c.label}`);
    console.log(`  href 属性: ${JSON.stringify(before.hrefAttr)} / 解決先: ${before.resolvedHref ?? '（なし）'}`);
    console.log(`  クリックが届いた要素: ${before.hitElement}（対象自身か: ${before.hitIsTarget}） / 移動: ${record.navigated ? 'する' : 'しない'}`);
    await context.close();
  }
  await browser.close();
}

server.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-click-target.mjs', root: ROOT, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
