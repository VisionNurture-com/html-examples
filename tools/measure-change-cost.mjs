// 外部 / 内部 / インラインの 3 方式を「変更コスト」と「変更が読者に届くか」で測る。
//
//   node tools/measure-change-cost.mjs
//
// 出力: tools/results/003-change-cost.json
//
// 主指標をサイズに置かない（抽象化の効果指標にサイズを使わない）。
// サイズは併記するが、方式の選択理由には使わない。

import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = join(ROOT, 'compare', '003-external-vs-internal-vs-inline');
const RESULTS = join(ROOT, 'tools', 'results');

const OLD_COLOR = '#1d4ed8';
const NEW_COLOR = '#b91c1c';
const OLD_RGB = 'rgb(29, 78, 216)';
const NEW_RGB = 'rgb(185, 28, 28)';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out.sort();
}

/** 基準色を 1 色変えるときに、どのファイルの何か所を開くことになるか。 */
async function changeCost(method) {
  const dir = join(BASE, method);
  const files = await walk(dir);
  let filesTouched = 0;
  let occurrences = 0;
  let totalBytes = 0;
  const detail = [];

  for (const f of files) {
    const text = await readFile(f, 'utf8');
    totalBytes += Buffer.byteLength(text);
    const n = text.split(OLD_COLOR).length - 1;
    if (n > 0) { filesTouched += 1; occurrences += n; }
    detail.push({ file: relative(BASE, f), occurrences: n, bytes: Buffer.byteLength(text) });
  }
  return { method, pages: files.filter((f) => f.endsWith('.html')).length, filesTouched, occurrences, totalBytes, detail };
}

/**
 * 色を変えたあと、既に一度ページを見た読者の画面に新しい色が届くか。
 * CSS は max-age=600 で配信し、HTML は no-store（よくある構成）。
 */
async function reachesReader(method, browser) {
  const dir = join(BASE, method);
  let edited = false;   // true にすると新しい色で配信する（= 制作者が色を変えた状態）

  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const file = join(dir, path === '/' ? 'index.html' : path.slice(1));
    let body;
    try { body = await readFile(file, 'utf8'); }
    catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    if (edited) body = body.split(OLD_COLOR).join(NEW_COLOR);
    const ext = extname(file);
    const headers = { 'content-type': MIME[ext] ?? 'text/plain' };
    headers['cache-control'] = ext === '.css' ? 'max-age=600' : 'no-store';
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  const before = await page.$eval('h1', (el) => getComputedStyle(el).color);

  edited = true;                                   // ここで制作者が色を変えた
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  const afterReload = await page.$eval('h1', (el) => getComputedStyle(el).color);

  await context.close();
  server.close();
  return {
    method,
    before,
    afterReload,
    reachedReader: afterReload === NEW_RGB,
    note: 'CSS は max-age=600 / HTML は no-store で配信。読者は変更前に一度ページを見ている',
  };
}

const methods = ['external', 'internal', 'inline'];
const browser = await chromium.launch();

const cost = [];
const reach = [];
for (const m of methods) {
  cost.push(await changeCost(m));
  reach.push(await reachesReader(m, browser));
}
const engineVersion = browser.version();
await browser.close();

const result = {
  scenario: '3 ページのサイトで基準色を 1 色変える',
  oldColor: OLD_COLOR,
  newColor: NEW_COLOR,
  expectedRgb: { old: OLD_RGB, new: NEW_RGB },
  engine: { name: 'chromium', version: engineVersion },
  changeCost: cost,
  reachesReader: reach,
  measuredAt: new Date().toISOString(),
  note: '主指標は「開くファイル数」と「変更が読者に届くか」。合計バイト数は併記のみで選択理由に使わない',
};

await mkdir(RESULTS, { recursive: true });
const file = join(RESULTS, '003-change-cost.json');
await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(JSON.stringify(result, null, 2));
