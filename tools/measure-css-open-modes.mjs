// html-basics 003: ページの開き方（ファイルをダブルクリック = file:// / 簡易サーバ = http://）で、
// 開発者ツールの Network パネルに渡る値と、CSS の書き換えが読み込み直しで届くかを測る。
//
//   node tools/measure-css-open-modes.mjs cdp          # Playwright の Chromium・CDP の Network イベントを記録
//   node tools/measure-css-open-modes.mjs mac "Google Chrome"   # macOS の実ブラウザで ⌘R（アクセシビリティの許可が要る）
//
// cdp: 存在する CSS と存在しない CSS を 1 つずつ読むページを、file:// と http:// で開き、
//      CSS ごとに status / statusText / mimeType / 失敗理由 を記録する（Network パネルの Status・Type 列の元になる値）。
// mac: file:// のページを開き、CSS を青 → 赤へ書き換えてから ⌘R を送り、2 回目の表示の色を記録する。
// 出力: JSON 1 行（標準出力）
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const BLUE = 'rgb(29, 78, 216)';
const RED = 'rgb(185, 28, 28)';

function makeSite(reportBase) {
  const dir = mkdtempSync(join(tmpdir(), 'open-modes-'));
  mkdirSync(join(dir, 'css'));
  writeFileSync(join(dir, 'css', 'style.css'), `h1 { color: ${BLUE}; }`);
  const report = reportBase
    ? `<script>addEventListener('load', () => { const c = getComputedStyle(document.querySelector('h1')).color; const n = performance.getEntriesByType('navigation')[0].type; new Image().src = '${reportBase}/report?color=' + encodeURIComponent(c) + '&nav=' + n; });</script>`
    : '';
  writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>css-open-modes</title>
<link rel="stylesheet" href="css/style.css"><link rel="stylesheet" href="css/missing.css">${report}</head><body><h1>今週のお知らせ</h1></body></html>`);
  return dir;
}

function serveDir(dir) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const file = p === '/' ? 'index.html' : p.slice(1);
    try {
      const body = execFileSync('cat', [join(dir, file)]);
      res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
      res.end(body);
    } catch { res.writeHead(404, { 'content-type': 'text/html' }); res.end('not found'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function viaCdp() {
  const pw = createRequire(import.meta.url)('playwright');
  const browser = await pw.chromium.launch();
  const out = { engine: 'chromium', version: browser.version(), modes: [] };
  const dir = makeSite(null);
  const { server, base } = await serveDir(dir);
  for (const [mode, url] of [['file', pathToFileURL(join(dir, 'index.html')).href], ['http', base + '/']]) {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const reqs = {};
    cdp.on('Network.requestWillBeSent', (e) => { if (e.request.url.includes('.css')) reqs[e.requestId] = { name: e.request.url.split('/').pop() }; });
    cdp.on('Network.responseReceived', (e) => { const r = reqs[e.requestId]; if (r) Object.assign(r, { status: e.response.status, statusText: e.response.statusText, mimeType: e.response.mimeType, protocol: e.response.protocol }); });
    cdp.on('Network.loadingFailed', (e) => { const r = reqs[e.requestId]; if (r) r.errorText = e.errorText; });
    cdp.on('Network.loadingFinished', (e) => { const r = reqs[e.requestId]; if (r) r.finished = true; });
    await page.goto(url); await page.waitForTimeout(500);
    const color = await page.$eval('h1', (e) => getComputedStyle(e).color);
    out.modes.push({ mode, scheme: new URL(url).protocol, h1Blue: color === BLUE, css: Object.values(reqs).sort((a, b) => a.name.localeCompare(b.name)) });
    await page.close();
  }
  server.closeAllConnections(); server.close();
  await browser.close(); rmSync(dir, { recursive: true, force: true });
  return out;
}

async function viaMac(app) {
  const reports = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/report') reports.push({ color: u.searchParams.get('color'), nav: u.searchParams.get('nav') });
    res.writeHead(204); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = makeSite(`http://127.0.0.1:${server.address().port}`);
  const wait = async (n) => { for (let i = 0; i < 100 && reports.length < n; i++) await new Promise((r) => setTimeout(r, 100)); };
  execFileSync('open', ['-a', app, pathToFileURL(join(dir, 'index.html')).href]);
  await wait(1);
  writeFileSync(join(dir, 'css', 'style.css'), `h1 { color: ${RED}; }`);
  execFileSync('osascript', ['-e', `tell application "${app}" to activate`, '-e', 'delay 0.5', '-e', 'tell application "System Events" to keystroke "r" using command down']);
  await wait(2);
  execFileSync('osascript', ['-e', `tell application "${app}" to activate`, '-e', 'delay 0.3', '-e', 'tell application "System Events" to keystroke "w" using command down']);
  server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
  const name = (c) => (c === BLUE ? '青（書き換え前）' : c === RED ? '赤（書き換え後）' : c);
  return { engine: app, driver: 'key(cmd+r)', scheme: 'file:', first: reports[0] && name(reports[0].color), second: reports[1] ? name(reports[1].color) : '報告なし', secondNavigationType: reports[1]?.nav ?? null };
}

const [mode, app] = process.argv.slice(2);
const result = mode === 'cdp' ? await viaCdp() : await viaMac(app);
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), ...result }));
process.exit(0);
