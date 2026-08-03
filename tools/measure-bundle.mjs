/**
 * measure-bundle.mjs — 同じタブ UI を「素の Web Components」と「React 最小構成」で作り、
 *                      バンドルサイズ・初期化時間・依存数を測る
 *
 * 使い方:
 *   node tools/measure-bundle.mjs
 *   node tools/measure-bundle.mjs --engine chromium
 *   node tools/measure-bundle.mjs --runs 10
 *   node tools/measure-bundle.mjs --out tools/results/008-bundle.json
 *
 * 🔴 測定規約（測る前に確定させたもの）
 *
 *   【バンドルサイズ】
 *     含む : 初回描画までにブラウザが取得する JS の全チャンク（vendor 含む）
 *     除く : HTML 本体 / CSS / source map
 *     単位 : raw / gzip / brotli の 3 つとも出す（単一の数字に丸めない）
 *     WC 版    = ビルドなしの .js そのもの
 *     React 版 = vite build の JS チャンク合計
 *
 *   【初期化時間】
 *     定義   : navigation start → タブ UI が操作可能になるまで
 *     観測点 : WC    = customElements.whenDefined() 解決後の最初の requestAnimationFrame
 *              React = root の描画完了を検出した後の最初の requestAnimationFrame
 *     🔴 両者は同じものを測っていない（観測点が実装により異なる）。
 *        この事実は結果 JSON の observationPoint に残し、記事本文にも明記する。
 *     試行   : エンジンごとに --runs 回（既定 10）実行し中央値を採る
 *
 *   【依存数】
 *     定義 : npm ls --all --omit=dev の実パッケージ数（推移的依存を含む）
 *     除く : devDependencies
 *     WC 版 = 0（package.json を持たない）
 *
 * 🔴 「小さいほうが良い」と書かない。
 *   本ハーネスが出すのは 3 つの数字だけで、配布範囲・寿命・チームのスキルは測れない。
 *
 * 依存: playwright（devDependencies）/ React 版のビルドに b-react の node_modules
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const WC_DIR = 'compare/008-wc-vs-react/a-wc';
const REACT_DIR = 'compare/008-wc-vs-react/b-react';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sizes(buffers) {
  const raw = Buffer.concat(buffers);
  return {
    rawBytes: raw.length,
    gzipBytes: gzipSync(raw).length,
    brotliBytes: brotliCompressSync(raw).length,
  };
}

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFilesUnder(p));
    // source map は規約により除く
    else if (extname(p) === '.js' && !p.endsWith('.map')) out.push(p);
  }
  return out;
}

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      let file = join(rootDir, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = { engines: Object.keys(ENGINES), runs: 10, out: 'tools/results/008-bundle.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') out.engines = [argv[i + 1]];
    if (argv[i] === '--runs') out.runs = Number(argv[i + 1]);
    if (argv[i] === '--out') out.out = argv[i + 1];
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const args = parseArgs(process.argv.slice(2));

// --- ① バンドルサイズ ---------------------------------------------------
// 🔴 b-react はリポジトリ直下とは別パッケージ。clean clone + ルートの npm install だけでは
//   vite が入らず `sh: vite: command not found` で落ちる（2026-08-02 に clean clone で実測）。
//   読者が README の手順どおりに叩いて動くよう、ここで足りない依存を入れる。
function ensureInstalled(dir) {
  if (existsSync(join(dir, 'node_modules'))) return;
  console.log(`installing dependencies in ${dir} ...`);
  execFileSync('npm', [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install'], {
    cwd: dir, stdio: 'inherit',
  });
}

ensureInstalled(REACT_DIR);
console.log('building React version...');
execFileSync('npm', ['run', 'build'], { cwd: REACT_DIR, stdio: 'pipe' });

const wcJs = [join(WC_DIR, 'my-tabs.js')];
const reactJs = jsFilesUnder(join(REACT_DIR, 'dist'));

const bundle = {
  wc: { files: wcJs, ...sizes(wcJs.map((f) => readFileSync(f))) },
  react: { files: reactJs, ...sizes(reactJs.map((f) => readFileSync(f))) },
};

// --- ② 依存数 -----------------------------------------------------------
function prodDependencyCount(dir) {
  if (!existsSync(join(dir, 'package.json'))) return { count: 0, note: 'package.json なし' };
  const out = execFileSync('npm', ['ls', '--all', '--omit=dev', '--parseable'], {
    cwd: dir, encoding: 'utf8',
  });
  const paths = out.split('\n').filter((l) => l.includes('node_modules'));
  return { count: paths.length, packages: paths.map((p) => p.split('node_modules/').pop()) };
}

const deps = { wc: prodDependencyCount(WC_DIR), react: prodDependencyCount(REACT_DIR) };

// --- ③ 初期化時間 -------------------------------------------------------
const { server, port } = await startServer(process.cwd());

const PAGES = {
  wc: {
    url: `http://127.0.0.1:${port}/${WC_DIR}/index.html`,
    observationPoint: "customElements.whenDefined('my-tabs') 解決後の最初の requestAnimationFrame",
    // 🔴 WC 版のタブは shadow root の内側にある。document.querySelector では見えない
    //    （最初の実装がこれで 0/10 になり、検算が測定の欠陥を拾った）
    operable: () => Boolean(
      document.getElementById('tabs')?.shadowRoot
        ?.querySelector('[role="tab"][aria-selected="true"]')),
    init: () => {
      window.__ready = new Promise((resolve) => {
        customElements.whenDefined('my-tabs').then(() => {
          requestAnimationFrame(() => resolve(performance.now()));
        });
      });
    },
  },
  react: {
    url: `http://127.0.0.1:${port}/${REACT_DIR}/dist/index.html`,
    observationPoint: 'root に data-ready が現れた後の最初の requestAnimationFrame',
    // React 版は light DOM に描画されるため通常の querySelector で足りる
    operable: () => Boolean(document.querySelector('[role="tab"][aria-selected="true"]')),
    init: () => {
      window.__ready = new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => resolve(performance.now()));
        const check = () => document.querySelector('#root [data-ready]');
        if (check()) { done(); return; }
        // init script は documentElement 生成前に走るため document を監視対象にする
        new MutationObserver((_, obs) => {
          if (check()) { obs.disconnect(); done(); }
        }).observe(document, { childList: true, subtree: true });
      });
    },
  },
};

const init = { };

for (const name of args.engines) {
  const browser = await ENGINES[name].launch();
  const version = browser.version();
  init[name] = { version, variants: {} };

  for (const [variant, page] of Object.entries(PAGES)) {
    const samples = [];
    let fetchedJs = null;
    for (let i = 0; i < args.runs; i += 1) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(page.init);
      const p = await ctx.newPage();
      // 🔴 規約は「初回描画までにブラウザが取得する JS」。ディスク上のファイルサイズを
      //   そのまま載せると、実際に取得されたものと一致する保証がない。1 回目だけ実測する。
      const seen = [];
      if (i === 0) {
        p.on('response', (res) => {
          const u = new URL(res.url());
          if (u.pathname.endsWith('.js') || u.pathname.endsWith('.jsx')) seen.push(u.pathname);
        });
      }
      await p.goto(page.url, { waitUntil: 'load' });
      const ms = await p.evaluate(() => window.__ready);
      // 操作可能になったことを実際に確かめる（測れているかの検算）
      const operable = await p.evaluate(page.operable);
      samples.push({ ms, operable });
      if (i === 0) fetchedJs = [...new Set(seen)].sort();
      await ctx.close();
    }
    const good = samples.filter((s) => s.operable).map((s) => s.ms);
    init[name].variants[variant] = {
      observationPoint: page.observationPoint,
      fetchedJs,
      runs: samples.length,
      operableRuns: good.length,
      medianMs: good.length ? Number(median(good).toFixed(2)) : null,
      minMs: good.length ? Number(Math.min(...good).toFixed(2)) : null,
      maxMs: good.length ? Number(Math.max(...good).toFixed(2)) : null,
      samplesMs: good.map((v) => Number(v.toFixed(2))),
    };
  }

  await browser.close();
}

server.close();

// 🔴 ディスク上のファイル一覧と、ブラウザが実際に取得した JS を突き合わせる
const firstEngine = Object.keys(init)[0];
const parity = {};
for (const [variant, planned] of [['wc', bundle.wc.files], ['react', bundle.react.files]]) {
  const fetched = init[firstEngine]?.variants[variant]?.fetchedJs ?? [];
  const plannedBase = planned.map((f) => f.split('/').pop()).sort();
  const fetchedBase = fetched.map((f) => f.split('/').pop()).sort();
  parity[variant] = {
    engine: firstEngine,
    measuredFiles: plannedBase,
    fetchedFiles: fetchedBase,
    match: JSON.stringify(plannedBase) === JSON.stringify(fetchedBase),
  };
}

const results = {
  measuredAt: new Date().toISOString(),
  spec: {
    bundle: 'JS 全チャンク（vendor 含む）/ HTML・CSS・source map は除く / raw・gzip・brotli を併記',
    init: '両者は観測点が異なるため同じものを測っていない（下記 observationPoint を参照）',
    deps: 'npm ls --all --omit=dev の実パッケージ数（推移的依存を含む・devDependencies 除く）',
  },
  bundle,
  bundleParity: parity,
  dependencies: deps,
  init,
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${args.out}\n`);

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log('【バンドルサイズ】');
for (const [k, v] of Object.entries(bundle)) {
  console.log(`  ${k.padEnd(6)} raw ${kb(v.rawBytes).padStart(9)} / gzip ${kb(v.gzipBytes).padStart(9)} / brotli ${kb(v.brotliBytes).padStart(9)}`);
}
console.log('\n【ディスク上のファイル ⟷ ブラウザが実際に取得した JS】');
for (const [k, v] of Object.entries(parity)) {
  console.log(`  ${k.padEnd(6)} ${v.match ? '一致' : '🔴 不一致'}  測定=${JSON.stringify(v.measuredFiles)} 取得=${JSON.stringify(v.fetchedFiles)}`);
}
console.log('\n【依存数（production）】');
for (const [k, v] of Object.entries(deps)) console.log(`  ${k.padEnd(6)} ${v.count}`);
console.log('\n【初期化時間（中央値・ミリ秒）】');
for (const [engine, d] of Object.entries(init)) {
  console.log(`  [${engine} ${d.version}]`);
  for (const [variant, v] of Object.entries(d.variants)) {
    console.log(`    ${variant.padEnd(6)} ${String(v.medianMs).padStart(7)} ms  (${v.operableRuns}/${v.runs} 回で操作可能を確認)`);
    console.log(`           観測点: ${v.observationPoint}`);
  }
}
