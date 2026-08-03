/**
 * measure-upgrade-timing.mjs — connectedCallback で子要素が見えないとき、
 *                              どの直し方が実際に効くかを測る
 *
 * 使い方:
 *   node tools/measure-upgrade-timing.mjs
 *   node tools/measure-upgrade-timing.mjs --engine chromium
 *   node tools/measure-upgrade-timing.mjs --out tools/results/008-upgrade-timing.json
 *
 * 測るもの: compare/008-upgrade-timing/ の 5 実装それぞれについて
 *   ① data-counted（数えた時点で見えていた <li> の数）
 *   ② 実際の <li> の数（描画後）
 *   ③ 数え終わったか（data-counted が設定されたか）
 *
 * 🔴 「マイクロタスクに送れば直る」といった通説を仮定しない。
 *   5 通りを同じ題材で走らせ、結果で判断する。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'compare/008-upgrade-timing';
const LABELS = {
  'a-head-define.html': '定義を head・その場で数える',
  'b-tail-define.html': '定義をページ末尾へ移す',
  'c-microtask.html': '定義は head・マイクロタスクへ送る',
  'd-timeout.html': '定義は head・setTimeout へ送る',
  'e-domcontentloaded.html': '定義は head・DOMContentLoaded を待つ',
};

const MIME = { '.html': 'text/html; charset=utf-8' };

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const file = join(rootDir, rel);
      if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = { engines: Object.keys(ENGINES), out: 'tools/results/008-upgrade-timing.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') out.engines = [argv[i + 1]];
    if (argv[i] === '--out') out.out = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targets = readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
const { server, port } = await startServer(process.cwd());
const results = { measuredAt: new Date().toISOString(), engines: {} };

for (const name of args.engines) {
  const browser = await ENGINES[name].launch();
  const version = browser.version();
  const page = await browser.newPage();
  const per = { version, targets: {} };

  for (const file of targets) {
    await page.goto(`http://127.0.0.1:${port}/${ROOT}/${file}`, { waitUntil: 'load' });
    // 非同期に数える実装があるため、設定されるまで少し待つ（待てたかを戻り値に残す）
    let settled = true;
    try {
      await page.waitForFunction(
        () => document.getElementById('target')?.dataset.counted !== undefined,
        null, { timeout: 3000 });
    } catch { settled = false; }

    const observed = await page.evaluate(() => {
      const host = document.getElementById('target');
      return {
        countedAtCallback: host.dataset.counted ?? null,
        actualLi: host.querySelectorAll('li').length,
      };
    });
    per.targets[file] = {
      label: LABELS[file] ?? file,
      countSettled: settled,
      ...observed,
      correct: observed.countedAtCallback === String(observed.actualLi),
    };
  }

  results.engines[name] = per;
  await browser.close();
}

server.close();
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${args.out}`);

for (const [engine, d] of Object.entries(results.engines)) {
  console.log(`\n[${engine} ${d.version}]`);
  for (const [file, v] of Object.entries(d.targets)) {
    console.log(`  ${v.correct ? '一致  ' : '不一致'} ${file.padEnd(26)} 数えた値=${String(v.countedAtCallback).padStart(4)} / 実際=${v.actualLi}  — ${v.label}`);
  }
}
