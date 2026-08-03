// CSS が「届いているか」を配信側の条件を変えて測る。
//
//   node tools/measure-css-delivery.mjs --mode content-type   # Content-Type と nosniff の組み合わせ
//   node tools/measure-css-delivery.mjs --mode cache          # キャッシュの 3 状態と再取得の有無
//
// 出力: tools/results/003-content-type.json / tools/results/003-cache.json
//
// 設計の前提（測っている対象が想定どおりか）:
//   - 適用の判定は getComputedStyle の実値で行う。<link> が 200 で返ったかどうかでは
//     判定しない（200 で返っても適用されない条件があるため、それ自体が測定対象）。
//   - キャッシュは transferSize だけで「再取得なし」と読まない。Network の応答（status /
//     fromDiskCache 相当）と Resource Timing の両方を突き合わせる。

import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'tools', 'results');

const BRAND = 'rgb(29, 78, 216)';   // #1d4ed8 を getComputedStyle が返す形
const CSS_BODY = 'h1 { color: #1d4ed8; }\n';

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'content-type';

const PAGE = (href) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
  `<title>CSS 配信プローブ</title><link rel="stylesheet" href="${href}"></head>` +
  `<body><h1 id="t">見出し</h1></body></html>`;

/** 1 ケース分の応答を返すだけのサーバを立てる。 */
function serveOnce({ contentType, nosniff, body = CSS_BODY, onRequest }) {
  const server = createServer((req, res) => {
    onRequest?.(req);
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE('/style.css'));
      return;
    }
    const headers = { 'cache-control': 'no-store' };
    if (contentType !== undefined) headers['content-type'] = contentType;
    if (nosniff) headers['x-content-type-options'] = 'nosniff';
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --- mode: content-type ------------------------------------------------------
// CSS の Content-Type が違うとき、標準モードの文書で適用されるか。
// 画像（007 の実測）では中身が正しければ Content-Type 不一致でも表示されたが、
// CSS で同じことが成り立つかは未検証だったため、ここで確かめる。
async function measureContentType() {
  const cases = [
    { id: 1, label: '中身 CSS / Content-Type: text/css（対照）', contentType: 'text/css', nosniff: false },
    { id: 2, label: '中身 CSS / Content-Type: text/css / nosniff あり', contentType: 'text/css', nosniff: true },
    { id: 3, label: '中身 CSS / Content-Type: text/plain', contentType: 'text/plain', nosniff: false },
    { id: 4, label: '中身 CSS / Content-Type: text/plain / nosniff あり', contentType: 'text/plain', nosniff: true },
    { id: 5, label: '中身 CSS / Content-Type: application/octet-stream', contentType: 'application/octet-stream', nosniff: false },
    { id: 6, label: '中身 CSS / Content-Type なし', contentType: undefined, nosniff: false },
    { id: 7, label: '中身 CSS / Content-Type: text/html', contentType: 'text/html', nosniff: false },
  ];

  const engines = { chromium, firefox, webkit };
  const out = {};

  for (const [name, engine] of Object.entries(engines)) {
    const browser = await engine.launch();
    out[name] = { version: browser.version(), cases: [] };
    for (const c of cases) {
      const { server, port } = await serveOnce({ contentType: c.contentType, nosniff: c.nosniff });
      const page = await browser.newPage();
      let status = null;
      // 読者が最初に見る文字列はコンソールに出る。適用可否だけでなく文言も採る
      // （文言はエンジンごとに異なるため、記事で併記するには実測が要る）。
      const consoleMessages = [];
      page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
      page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: String(err) }));
      page.on('response', (r) => { if (r.url().endsWith('/style.css')) status = r.status(); });
      await page.goto(`http://127.0.0.1:${port}/page`, { waitUntil: 'load' });
      await page.waitForTimeout(200);   // コンソール出力は load より後に届くことがある
      const color = await page.$eval('#t', (el) => getComputedStyle(el).color);
      await page.close();
      server.close();
      out[name].cases.push({
        id: c.id,
        label: c.label,
        contentType: c.contentType ?? '(なし)',
        nosniff: c.nosniff,
        httpStatus: status,
        computedColor: color,
        applied: color === BRAND,
        consoleMessages,
      });
    }
    await browser.close();
  }
  return { mode: 'content-type', brandColor: BRAND, engines: out };
}

// --- mode: cache -------------------------------------------------------------
// 同じ URL を 2 回読むと何が起きるか。URL を変えると何が変わるか。
// 「再取得されたか」を transferSize 単独で判定せず、サーバに届いたリクエスト数と
// 突き合わせる（サーバが数えた回数が唯一の客観値）。
async function measureCache() {
  const engines = { chromium, firefox, webkit };
  const out = {};

  for (const [name, engine] of Object.entries(engines)) {
    const browser = await engine.launch();
    const scenarios = [];

    for (const sc of [
      { id: 'same-url', label: '同じ URL を 2 回読む（max-age=600）', second: '/style.css' },
      { id: 'versioned-url', label: '2 回目だけ URL を変える（?v=2）', second: '/style.css?v=2' },
    ]) {
      let hits = 0;
      const server = createServer((req, res) => {
        if (req.url.startsWith('/page')) {
          const href = req.url.includes('second') ? sc.second : '/style.css';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(PAGE(href));
          return;
        }
        // 🔴 パスを限定して数える。/page 以外をすべて CSS と数えると、
        // Firefox が自動で取りに来る /favicon.ico まで「再取得」に混ざる
        // （実際に混ざり、Firefox だけ回数が 1 多いという誤った差が出た）。
        if (!req.url.startsWith('/style.css')) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        hits += 1;
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=600' });
        res.end(CSS_BODY);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/page`, { waitUntil: 'load' });
      const first = await page.evaluate(() => {
        const e = performance.getEntriesByType('resource').find((x) => x.name.includes('style.css'));
        return e ? { transferSize: e.transferSize, encodedBodySize: e.encodedBodySize } : null;
      });
      await page.goto(`http://127.0.0.1:${port}/page?second=1`, { waitUntil: 'load' });
      const second = await page.evaluate(() => {
        const e = performance.getEntriesByType('resource').filter((x) => x.name.includes('style.css')).pop();
        return e ? { transferSize: e.transferSize, encodedBodySize: e.encodedBodySize } : null;
      });
      const color = await page.$eval('#t', (el) => getComputedStyle(el).color);
      await context.close();
      server.close();

      scenarios.push({
        id: sc.id,
        label: sc.label,
        serverHits: hits,               // サーバが実際に受けた CSS のリクエスト数
        firstLoad: first,
        secondLoad: second,
        appliedAfterSecond: color === BRAND,
      });
    }

    out[name] = { version: browser.version(), scenarios };
    await browser.close();
  }
  return { mode: 'cache', engines: out };
}

const result = mode === 'cache' ? await measureCache() : await measureContentType();
result.measuredAt = new Date().toISOString();
result.note = '判定は getComputedStyle の実値。キャッシュの再取得はサーバが数えたリクエスト数を正本とする。';

await mkdir(RESULTS, { recursive: true });
const file = join(RESULTS, mode === 'cache' ? '003-cache.json' : '003-content-type.json');
await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(JSON.stringify(result, null, 2));
