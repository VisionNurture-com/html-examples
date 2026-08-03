/**
 * measure-scroll-lock.mjs — 症状ページと修正版ページの挙動を並べて測る
 *
 * 使い方:
 *     node tools/measure-scroll-lock.mjs [--engine chromium] [--out tools/results/004-symptoms.json]
 *
 * なぜ要るのか:
 *     measure-dialog-close.mjs は compare/004-close-control の 5 実装だけを測る。
 *     記事が「症状 → 修正」として載せている symptoms/004-modal-not-closing の 2 枚は
 *     どのハーネスの対象にも入っておらず、記事の「実行結果」に生ログが無い状態だった。
 *     とくに修正版が主張する「開いている間は後ろのページが動かない」は
 *     body:has(dialog[open]) { overflow: hidden } の効きそのもので、測らないと確かめられない。
 *
 * 測るもの（両ページを同じ手順で）:
 *     ① 開けたか ② 開いている間にホイールを回して背面が動くか
 *     ③ Esc で閉じるか ④ 外側のクリックで閉じるか（合成クリック。実機は別途 手で測る）
 *     ⑤ キーボードで開いて閉じたとき、開いたボタンへ戻るか
 *
 * ⚠️ 合成イベントでは light dismiss が発火しない実装がある（004-outside-click.json）。
 *    ④ は自動測定としての値であり、実機の値は人のマウス操作で別に測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'symptoms/004-modal-not-closing';
const TARGETS = [
  { file: 'broken.html', label: '症状（閉じない）', kind: 'custom' },
  { file: 'fixed.html', label: '修正版（closedby + overflow 固定）', kind: 'dialog' }
];

// 🔴 実装ごとに「開いているか」の判定式が違う。共通式を当てると症状ページが常に
//    「閉じている」と読まれ、Esc も外側クリックも「閉じた」という偽の値が並ぶ。
const OPEN_EXPR = {
  custom: () => document.getElementById('box').hasAttribute('data-open'),
  dialog: () => document.getElementById('box').open === true
};

// 閉じ方も実装ごとに違う。div に close() は無い
const CLOSE_EXPR = {
  custom: () => document.getElementById('box').removeAttribute('data-open'),
  dialog: () => document.getElementById('box').close()
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const activeId = () => (document.activeElement ? (document.activeElement.id || document.activeElement.tagName.toLowerCase()) : null);

async function measureOne(page, url, target) {
  const isOpen = OPEN_EXPR[target.kind];
  const doClose = CLOSE_EXPR[target.kind];
  const out = { file: target.file, label: target.label, kind: target.kind };
  await page.goto(url);

  // 題材が症状を再現しているかを先に確かめる
  out.hasScrollLockRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes('dialog[open]')) return rule.cssText;
        }
      } catch { /* cross-origin は無視 */ }
    }
    return null;
  });

  await page.click('#open');
  out.openedOk = await page.evaluate(isOpen);
  if (!out.openedOk) {
    // 開けていない状態で Esc / 外側を測ると「閉じた」という偽の値が出る
    out.abort = '開けなかったため以降を測っていません';
    return out;
  }

  // ② 開いている間にホイールを回す
  out.scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  out.scrollAfterWheel = await page.evaluate(() => window.scrollY);
  out.backgroundScrolls = out.scrollAfterWheel > out.scrollBeforeWheel;
  await page.evaluate(() => window.scrollTo(0, 0));

  // ③ Esc
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  out.escCloses = (await page.evaluate(isOpen)) === false;

  // ④ 外側のクリック（合成）
  if (out.escCloses) await page.click('#open');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  out.outsideClickCloses = (await page.evaluate(isOpen)) === false;

  // ⑤ キーボードで開いて閉じたときの戻り先
  await page.evaluate(() => window.scrollTo(0, 0));
  if (await page.evaluate(isOpen)) await page.evaluate(doClose);
  await page.focus('#open');
  out.openerFocusedBeforeOpen = (await page.evaluate(activeId)) === 'open';
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  out.openedByKeyboard = await page.evaluate(isOpen);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  out.closedByKeyboard = (await page.evaluate(isOpen)) === false;
  out.focusAfterCloseKeyboard = await page.evaluate(activeId);
  out.focusReturnedToOpener = out.closedByKeyboard ? out.focusAfterCloseKeyboard === 'open' : null;

  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { server, port } = await startServer();
  const results = { measuredAt: new Date().toISOString(), root: ROOT, engines: {} };

  for (const name of opts.engines) {
    const browser = await ENGINES[name].launch();
    const entry = { version: browser.version(), targets: [] };
    const page = await browser.newPage();
    for (const t of TARGETS) {
      entry.targets.push(await measureOne(page, `http://127.0.0.1:${port}/${t.file}`, t));
    }
    await browser.close();
    results.engines[name] = entry;
    console.log(`[${name} ${entry.version}]`);
    for (const r of entry.targets) {
      console.log(`  ${r.label.padEnd(34)} open=${r.openedOk} 背面scroll=${r.backgroundScrolls}(${r.scrollBeforeWheel}→${r.scrollAfterWheel}) Esc=${r.escCloses} 外側=${r.outsideClickCloses} 復帰=${r.focusReturnedToOpener}`);
    }
  }

  server.close();
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\n→ ${opts.out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
