/**
 * measure-react-interop.mjs — React の中で独自要素を使うとき、値とイベントがどう渡るかを測る
 *
 * 使い方:
 *   node tools/measure-react-interop.mjs
 *   node tools/measure-react-interop.mjs --engine chromium
 *   node tools/measure-react-interop.mjs --out tools/results/008-react-interop.json
 *
 * 前提なし: 依存の導入とビルドは本ハーネスが行う。
 *   🔴 compare/008-react-interop はリポジトリ直下とは別パッケージで、clean clone +
 *      ルートの npm install だけでは vite が入らない（2026-08-02 に clean clone で実測）。
 *
 * 測るもの:
 *   ① JSX で配列を渡したとき、属性になるかプロパティになるか
 *   ② 独自イベントが React 側の addEventListener に届くか
 *      - early: 独自要素の connectedCallback 直後（setTimeout 0）に発火
 *      - late : 250 ms 後に発火
 *
 * 🔴 early だけを測って「React は独自イベントを受け取れない」と書かない。
 *   最初の実装は early のみを測り 3 エンジンとも false だった。late を足して初めて
 *   「受け取れないのではなく、登録が間に合っていない」と切り分けられた。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const APP_DIR = 'compare/008-react-interop';
const PAGE = `${APP_DIR}/dist/index.html`;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      let file = join(rootDir, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = { engines: Object.keys(ENGINES), out: 'tools/results/008-react-interop.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') out.engines = [argv[i + 1]];
    if (argv[i] === '--out') out.out = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// 依存の導入とビルドを本ハーネスが行う（読者が 1 コマンドで追試できるように）
if (!existsSync(join(APP_DIR, 'node_modules'))) {
  console.log(`installing dependencies in ${APP_DIR} ...`);
  execFileSync('npm', [existsSync(join(APP_DIR, 'package-lock.json')) ? 'ci' : 'install'], {
    cwd: APP_DIR, stdio: 'inherit',
  });
}
console.log('building React interop sample...');
execFileSync('npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'pipe' });

const { server, port } = await startServer(process.cwd());
const results = {
  measuredAt: new Date().toISOString(),
  react: '19.2.8',
  vite: '8.2.0',
  note: 'early = connectedCallback 直後（setTimeout 0）に発火 / late = 250 ms 後に発火',
  engines: {},
};

for (const name of args.engines) {
  const browser = await ENGINES[name].launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/${PAGE}`, { waitUntil: 'load' });
  // late の発火（250 ms）より十分あとまで待つ
  await page.waitForTimeout(800);

  const observed = await page.evaluate(() => {
    const el = document.querySelector('my-badge');
    const res = document.getElementById('event-result');
    return {
      received: el ? JSON.parse(el.dataset.received || '{}') : null,
      hasItemsAttribute: el ? el.hasAttribute('items') : null,
      itemsAttributeValue: el ? el.getAttribute('items') : null,
      earlyEventSeen: res?.dataset.earlySeen,
      lateEventSeen: res?.dataset.lateSeen,
    };
  });

  results.engines[name] = { version: browser.version(), ...observed };
  await browser.close();
}

server.close();
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${args.out}\n`);

for (const [engine, d] of Object.entries(results.engines)) {
  console.log(`[${engine} ${d.version}]`);
  console.log(`  値の渡り方   : property=${d.received?.viaProperty} / attribute=${d.received?.viaAttribute}`);
  console.log(`  items 属性   : ${d.hasItemsAttribute}`);
  console.log(`  early イベント: ${d.earlyEventSeen}`);
  console.log(`  late イベント : ${d.lateEventSeen}`);
}
