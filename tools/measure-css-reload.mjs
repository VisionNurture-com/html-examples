// html-basics 003: CSS を読み込み直したとき、ブラウザは CSS を取りに行くか
//
//   node tools/measure-css-reload.mjs playwright <chromium|firefox|webkit>
//   node tools/measure-css-reload.mjs key <名前> -- <ブラウザを起動するコマンド…>   # Xvfb 上で実行・xdotool が要る
//
// HTML は毎回取り直させ（no-store）、CSS の保存の指定だけを変える。
//   max-age=600 … 10 分は手元のものを使ってよい（本文の症状 4）
//   no-cache    … 使う前に必ず確かめる（陽性対照: 読み込み直しで要求が届くはず）
// 1 回目の表示のあとで CSS の色を青 → 赤へ書き換え、2 回目の表示で何が起きたかを、
// サーバ側の到着（200 / 304 / 到着なし）と、ページが返す計算後の色で判定する。
// 出力: JSON 1 行（標準出力）
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BLUE = 'rgb(29, 78, 216)';
const RED = 'rgb(185, 28, 28)';

function startServer(cacheControl) {
  const state = { version: 1, css: [], reports: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/style.css') {
      const etag = `"v${state.version}"`;
      const inm = req.headers['if-none-match'] || null;
      const status = inm === etag ? 304 : 200;
      state.css.push({ t: Date.now(), status, ifNoneMatch: inm, cacheControlReq: req.headers['cache-control'] || null });
      res.writeHead(status, { 'content-type': 'text/css', 'cache-control': cacheControl, etag });
      return res.end(status === 304 ? undefined : `h1 { color: ${state.version === 1 ? BLUE : RED}; }`);
    }
    if (url.pathname === '/report') {
      state.reports.push({ t: Date.now(), color: url.searchParams.get('color'), nav: url.searchParams.get('nav') });
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>css-reload</title>
<link rel="stylesheet" href="/style.css"></head><body><h1>今週のお知らせ</h1><a id="again" href="/page">もう一度開く</a>
<script>addEventListener('load', () => { const n = performance.getEntriesByType('navigation')[0];
fetch('/report?color=' + encodeURIComponent(getComputedStyle(document.querySelector('h1')).color) + '&nav=' + (n ? n.type : ''), { cache: 'no-store' }); });</script>
</body></html>`);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

function summarize(state, flipAt) {
  const after = state.css.filter((c) => c.t >= flipAt);
  const second = state.reports.at(-1);
  return {
    cssBeforeFlip: state.css.filter((c) => c.t < flipAt).map((c) => c.status),
    cssAfterFlip: after.length ? after.map((c) => c.status) : ['到着なし'],
    cacheControlRequestHeader: after.map((c) => c.cacheControlReq),
    secondColor: second?.color === RED ? '赤（新しい CSS）' : second?.color === BLUE ? '青（古い CSS）' : second?.color ?? '報告なし',
    secondNavigationType: second?.nav ?? null,
  };
}

async function viaPlaywright(engine) {
  const { createRequire } = await import('node:module');
  const pw = createRequire(import.meta.url)('playwright');
  const out = [];
  for (const cache of ['max-age=600', 'no-cache']) {
    for (const how of ['reload', 'link']) {
      const { server, state, base } = await startServer(cache);
      const browser = await pw[engine].launch();
      const page = await (await browser.newContext()).newPage();
      await page.goto(base + '/page');
      await waitFor(() => state.reports.length >= 1);
      const flipAt = Date.now(); state.version = 2;
      if (how === 'reload') await page.reload(); else await page.click('#again');
      await waitFor(() => state.reports.length >= 2);
      out.push({ driver: 'playwright', engine, version: browser.version(), cache, how, firstColor: state.reports[0]?.color, ...summarize(state, flipAt) });
      await browser.close(); server.close();
    }
  }
  return out;
}

async function viaKey(name, cmd) {
  const out = [];
  for (const cache of ['max-age=600', 'no-cache']) {
    const { server, state, base } = await startServer(cache);
    const profile = mkdtempSync(join(tmpdir(), 'css-reload-'));
    const args = cmd.map((a) => a.replace('{profile}', profile).replace('{url}', base + '/page'));
    const child = spawn(args[0], args.slice(1), { stdio: 'ignore', env: process.env, detached: true });
    const ok1 = await waitFor(() => state.reports.length >= 1, 60000);
    let win = null;
    try { win = execFileSync('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'css-reload'], { timeout: 20000 }).toString().trim().split('\n').at(-1); } catch { /* 窓が見つからない */ }
    const flipAt = Date.now(); state.version = 2;
    let keySent = false;
    if (ok1 && win) {
      try { execFileSync('xdotool', ['windowactivate', '--sync', win], { timeout: 5000 }); } catch { /* ウィンドウマネージャが無いと失敗する */ }
      execFileSync('xdotool', ['windowfocus', '--sync', win], { timeout: 5000 });
      execFileSync('xdotool', ['key', '--window', win, '--clearmodifiers', 'ctrl+r']); keySent = true;
    }
    await waitFor(() => state.reports.length >= 2, 20000);
    out.push({ driver: 'key(ctrl+r)', engine: name, cache, how: 'reload', firstReported: ok1, windowFound: Boolean(win), keySent, firstColor: state.reports[0]?.color, reports: state.reports.length, ...summarize(state, flipAt) });
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 既に終わっている */ }
    server.closeAllConnections(); server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  return out;
}


// macOS の実ブラウザ（osascript で ⌘R を送る。アクセシビリティの許可が要る）
async function viaMac(app) {
  const out = [];
  for (const cache of ['max-age=600', 'no-cache']) {
    const { server, state, base } = await startServer(cache);
    const profile = mkdtempSync(join(tmpdir(), 'css-reload-'));
    if (app === 'Safari') execFileSync('open', ['-a', 'Safari', base + '/page']);
    else execFileSync('open', ['-na', app, '--args', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', base + '/page']);
    const ok1 = await waitFor(() => state.reports.length >= 1, 60000);
    const flipAt = Date.now(); state.version = 2;
    let keySent = false;
    if (ok1) {
      await new Promise((r) => setTimeout(r, 1000));
      execFileSync('osascript', ['-e', `tell application "${app}" to activate`, '-e', 'delay 0.5', '-e', 'tell application "System Events" to keystroke "r" using command down']);
      keySent = true;
    }
    await waitFor(() => state.reports.length >= 2, 20000);
    out.push({ driver: 'key(cmd+r)', engine: app, cache, how: 'reload', firstReported: ok1, keySent, firstColor: state.reports[0]?.color, reports: state.reports.length, ...summarize(state, flipAt) });
    if (app !== 'Safari') { try { execFileSync('pkill', ['-f', `user-data-dir=${profile}`]); } catch { /* 終わっている */ } }
    server.closeAllConnections(); server.close();
  }
  return out;
}

const [mode, a, ...rest] = process.argv.slice(2);
const result = mode === 'playwright' ? await viaPlaywright(a) : mode === 'mac' ? await viaMac(a) : await viaKey(a, rest.slice(rest.indexOf('--') + 1));
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), result }));
process.exit(0);
