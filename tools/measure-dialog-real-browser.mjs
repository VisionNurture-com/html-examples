/**
 * measure-dialog-real-browser.mjs — 実機ブラウザで「Tab がページの外へ出るか」を測る
 *
 * 使い方:
 *   node tools/measure-dialog-real-browser.mjs
 *   node tools/measure-dialog-real-browser.mjs --out tools/results/004-real-browser.json
 *
 * 測るもの: 実機 Google Chrome / Safari で
 *   ① モーダルを開いた状態から Tab を押し続けたとき、フォーカスがページの外
 *      （ブラウザ UI）へ出るか
 *   ② closedby 属性がそのブラウザで解釈されるか
 *   ③ closedby="any" のダイアログが外側クリックで閉じるか
 *
 * 🔴 Playwright ではこれを測れない。Playwright の Tab はページ内で完結するため、
 *   「ブラウザ UI へ抜けたか」は実機でしか観測できない（CSS-Tricks の主張の検証点）。
 *
 * 🔴 前提（macOS の許可 6 層）:
 *   - /usr/bin/osascript と親アプリをアクセシビリティに登録
 *   - Chrome:  表示 > デベロッパー > Apple Events からの JavaScript を許可
 *   - Safari:  開発 > Apple Events からの JavaScript を許可
 *   これらは自動化できない。未設定なら本スクリプトは permissionError を記録して続行する。
 *
 * ⚠️ ページ内フォーカスの読み取りは document.activeElement を使う。
 *   実機 Chrome の AXFocusedUIElement はページ内の焦点を返さない。
 *
 * 依存: なし（osascript と Node 標準のみ）
 */

import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ROOT = 'compare/004-close-control';
const PORT = 8765;
const TAB_LIMIT = 8;

const BROWSERS = [
  {
    name: 'Google Chrome',
    open: (url) => `tell application "Google Chrome"\nactivate\nif (count of windows) = 0 then make new window\nset URL of active tab of front window to "${url}"\nend tell`,
    js: (code) => `tell application "Google Chrome" to execute front window's active tab javascript "${code.replace(/"/g, '\\"')}"`
  },
  {
    name: 'Safari',
    open: (url) => `tell application "Safari"\nactivate\nset URL of front document to "${url}"\nend tell`,
    js: (code) => `tell application "Safari" to do JavaScript "${code.replace(/"/g, '\\"')}" in front document`
  }
];

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  return opts;
}

function osa(script) {
  try {
    return { ok: true, value: execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 20000 }).trim() };
  } catch (e) {
    return { ok: false, value: null, error: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

const delay = (sec) => osa(`delay ${sec}`);
// キーは対象プロセスへ明示的に送る（前面のアプリが別だと届かない）
const pressTab = (proc, withOption = false) => osa(
  `tell application "${proc}" to activate\ndelay 0.2\n`
  + `tell application "System Events" to tell process "${proc}" to key code 48${withOption ? ' using {option down}' : ''}`
);

// ページ左上のスクリーン座標を JS から求める（固定座標では着弾しない）。
// window.screenX/screenY とブラウザクロム高さ（outerHeight - innerHeight）から算出する。
function pageOrigin(b) {
  const v = osa(b.js('window.screenX + "," + (window.screenY + (window.outerHeight - window.innerHeight))')).value;
  if (!v || !v.includes(',')) return null;
  const [x, y] = v.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// 🔴 `lsof -ti:PORT` はリッスン側だけでなく、自プロセスがそのポートへ張った
//   クライアント側ソケットも拾う。素で kill -9 に渡すと自分自身が落ちる（実際に
//   NODE_EXIT=137 で結果を書き出す前に死んだ）。LISTEN に限定し、自 PID を除外する。
function freePort(port) {
  try {
    execFileSync('/bin/sh', ['-c',
      `lsof -ti:${port} -sTCP:LISTEN | grep -v '^${process.pid}$' | xargs kill -9 2>/dev/null || true`
    ], { stdio: 'ignore' });
  } catch { /* 無ければ何もしない */ }
}

// 🔴 サーバは別プロセスに置く。
//   同一プロセスに置くと osascript の同期呼び出し（execFileSync）がイベントループを止め、
//   ブラウザからのリクエストに応答できない。初回はこれで chrome-error://chromewebdata/ になった。
const SERVER_SRC = `
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
const ROOT = ${JSON.stringify(ROOT)};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
createServer((req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(${PORT}, '127.0.0.1', () => console.log('ready'));
`;

async function startServer() {
  freePort(PORT); // 前回の残留を確実に落としてから起動する
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER_SRC], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 到達の積極確認: 実際に 200 が返るまで待つ（起動したことを応答の代わりにしない）
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/b-dialog.html`);
      if (r.ok) return { child, port: PORT };
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  child.kill();
  throw new Error(`server did not become ready on ${PORT}`);
}

const ACTIVE_ID = 'document.activeElement ? (document.activeElement.id || document.activeElement.tagName.toLowerCase()) : null';

// 🔴 到達の積極確認。URL を設定しただけでは開けたことにならない。
//   実際に対象ページが読み込まれ、目印の要素が存在するまで待ってから測る。
function openAndVerify(b, url, marker = 'box') {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt === 0) osa(b.open(url));
    delay(1);
    const href = osa(b.js('location.href')).value;
    const ready = osa(b.js('document.readyState')).value;
    const has = osa(b.js(`!!document.getElementById('${marker}')`)).value;
    if (href === url && ready === 'complete' && has === 'true') {
      return { ok: true, href, attempts: attempt + 1 };
    }
  }
  return {
    ok: false,
    href: osa(b.js('location.href')).value,
    marker: osa(b.js(`!!document.getElementById('${marker}')`)).value
  };
}

function measureBrowser(b, base) {
  const out = { browser: b.name };

  // 前提の検算: do JavaScript が実際に通るか（「設定した」を根拠にしない）
  const probe = osa(b.js('1+1'));
  out.appleEventsJs = probe.ok ? probe.value : null;
  if (!probe.ok) { out.permissionError = probe.error; return out; }

  // ② closedby の対応（feature detection）
  const nav1 = openAndVerify(b, `${base}/c-closedby-any.html`);
  out.pageLoadedClosedby = nav1;
  if (!nav1.ok) { out.abort = 'c-closedby-any.html を開けませんでした（未測定）'; return out; }
  out.closedbySupported = osa(b.js("'closedBy' in HTMLDialogElement.prototype")).value;
  out.closedByValue = osa(b.js("document.getElementById('box').closedBy || 'undefined'")).value;
  out.closedbyAttrInDom = osa(b.js("document.getElementById('box').getAttribute('closedby')")).value;

  // ③ closedby="any" が外側クリックで閉じるか（クリックは合成せず elementFromPoint 相当の座標へ送らない。
  //    ここではブラウザ既定の light dismiss を確かめるため、実際のマウスクリックを System Events で送る）
  osa(b.js("document.getElementById('open').click()"));
  delay(1);
  out.openedForOutside = osa(b.js("document.getElementById('box').open")).value;
  // 🔴 着弾の積極確認。「クリックを送った」と「ページに届いた」は別の事実。
  //   ページ側にリスナーを仕込み、実際に click が観測されたときだけ結果を採用する。
  const origin = pageOrigin(b);
  out.pageOrigin = origin;
  if (origin) {
    // ダイアログは inset 30% 20% のため、ページ左上から (20, 20) は確実にその外側
    osa(b.js("window.__hit=null;document.addEventListener('click',e=>{window.__hit=e.clientX+','+e.clientY},{once:true,capture:true})"));
    const click = osa(`tell application "System Events" to click at {${origin.x + 20}, ${origin.y + 20}}`);
    out.outsideClickSent = click.ok;
    out.outsideClickError = click.ok ? null : click.error;
    delay(1);
    out.outsideClickLanded = osa(b.js('window.__hit')).value;
    const landed = out.outsideClickLanded && !['missing value', '', 'null'].includes(out.outsideClickLanded);
    // 着弾が確認できたときだけ判定する。届いていない結果を「閉じなかった」と読まない
    out.outsideClickCloses = landed ? osa(b.js("document.getElementById('box').open")).value === 'false' : null;
  } else {
    out.outsideClickCloses = null;
    out.outsideClickLanded = 'ページ原点を取得できず';
  }

  // ① Tab がページの外へ出るか（showModal の既定で測る）
  const nav2 = openAndVerify(b, `${base}/b-dialog.html`);
  out.pageLoadedTab = nav2;
  if (!nav2.ok) { out.abort = 'b-dialog.html を開けませんでした（未測定）'; return out; }
  osa(b.js("document.getElementById('open').click()"));
  delay(1);
  out.openedForTab = osa(b.js("document.getElementById('box').open")).value;
  if (out.openedForTab !== 'true') { out.abort = 'ダイアログが開きませんでした（未測定）'; return out; }
  out.focusAfterOpen = osa(b.js(ACTIVE_ID)).value;
  // Tab（素）で測る。動かなければ Option+Tab へ手法を変えて測り直す。
  // Safari は「Tab キーで各項目を強調表示」が既定 OFF で、素の Tab ではフォームコントロールしか
  // 巡回しない。Option+Tab は同じ設定を一時的に反転させる経路として文書化されている。
  const runTabs = (withOption) => {
    const seq = [osa(b.js(ACTIVE_ID)).value];
    for (let i = 0; i < TAB_LIMIT; i += 1) {
      pressTab(b.name, withOption);
      delay(0.4);
      seq.push(osa(b.js(ACTIVE_ID)).value);
    }
    return seq;
  };
  const plain = runTabs(false);
  out.tabOrder = plain;
  out.tabMoved = new Set(plain.filter(Boolean)).size >= 2;
  out.tabMethod = 'Tab';
  if (!out.tabMoved) {
    // 手法を変えて再測定（開き直してから）
    osa(b.js("document.getElementById('box').close()"));
    delay(0.5);
    osa(b.js("document.getElementById('open').click()"));
    delay(0.5);
    const alt = runTabs(true);
    out.tabOrderOptionTab = alt;
    if (new Set(alt.filter(Boolean)).size >= 2) {
      out.tabOrder = alt;
      out.tabMoved = true;
      out.tabMethod = 'Option+Tab';
    }
  }
  // ページ外へ出た = 途中で activeElement が body / null に落ちた
  out.tabLeftPage = out.tabMoved ? out.tabOrder.slice(1).some((x) => x === 'body' || x === 'null' || x === '') : null;

  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { child, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const results = { measuredAt: new Date().toISOString(), root: ROOT, tabLimit: TAB_LIMIT, browsers: [] };

  for (const b of BROWSERS) {
    const r = measureBrowser(b, base);
    results.browsers.push(r);
    if (r.permissionError) {
      console.log(`${b.name.padEnd(14)} 🔴 permissionError: ${r.permissionError}`);
    } else if (r.abort) {
      console.log(`${b.name.padEnd(14)} 🔴 ${r.abort}  href=${r.pageLoadedTab?.href ?? r.pageLoadedClosedby?.href}`);
    } else {
      const oc = r.outsideClickCloses === null ? `未測定(着弾=${r.outsideClickLanded})` : String(r.outsideClickCloses);
      const tl = r.tabLeftPage === null ? '未測定(Tab不動)' : String(r.tabLeftPage);
      console.log(`${b.name.padEnd(14)} closedby対応=${r.closedbySupported} closedBy値=${r.closedByValue} 外側クリックで閉じる=${oc} Tab動いた=${r.tabMoved} ページ外へ=${tl}`);
      console.log(`${''.padEnd(14)} tabOrder=${JSON.stringify(r.tabOrder)}`);
    }
  }

  child.kill('SIGKILL');
  freePort(PORT);
  // 後始末の積極確認: ポートが実際に解放されたかを確かめる（kill を解放の代わりにしない）
  for (let i = 0; i < 20; i += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/b-dialog.html`); } catch { break; }
    await new Promise((res) => setTimeout(res, 200));
  }
  try {
    await fetch(`http://127.0.0.1:${PORT}/b-dialog.html`);
    console.warn(`⚠️ port ${PORT} がまだ応答します`);
  } catch { console.log(`port ${PORT} 解放済み`); }
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${opts.out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
