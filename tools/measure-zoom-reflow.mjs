/**
 * measure-zoom-reflow.mjs — 拡大したときの崩れと、見た目の並びの入れ替わりを測る
 *
 * 使い方:
 *   node tools/measure-zoom-reflow.mjs compare/006-counting-basis/g-manual-checks.html
 *   node tools/measure-zoom-reflow.mjs --engine webkit <file.html> [<file.html> ...]
 *   node tools/measure-zoom-reflow.mjs --out tools/results/006-zoom-reflow.json <files...>
 *
 * 測るもの:
 *   ① 横にあふれるか（documentElement の scrollWidth ⟷ clientWidth）を 2 つの幅で測る
 *      - 1280px（等倍）と 640px（幅を半分にした状態 = CSS ピクセル基準で 200% 相当）
 *   ② 書いた順（DOM 順）と、見た目の読み順（上から下・左から右）が入れ替わる箇所
 *
 * なぜ幅を半分にするのか:
 *   ブラウザのズームで 200% にすると、CSS ピクセル基準では viewport の幅が半分になる。
 *   実機のズーム操作と、この自動測定の対応関係を確かめるためにこの条件を使う。
 *
 * 🔴 これは実機手順の置き換えではない:
 *   Lighthouse が「人が確認する」とした 10 項目のうち visual-order-follows-dom は、
 *   幾何としてはここで測れる。測れるのに採点していないという事実を記録するための道具であり、
 *   「崩れているか」「読める並びか」の判断そのものは人が行う。
 *
 * ⚠️ 測らない範囲: OS の拡大鏡・ピンチズーム・user-scalable=no の影響は測らない。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = '.';
const WIDTHS = [
  { id: 'base', width: 1280, label: '等倍（1280px）' },
  { id: 'zoom200', width: 640, label: '200% 相当（幅を半分の 640px に）' }
];

function parseArgs(argv) {
  const opts = { engines: ['chromium'], out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else opts.files.push(argv[i]);
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  if (opts.files.length === 0) throw new Error('測る HTML ファイルを 1 つ以上指定する');
  return opts;
}

function startServer() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^\/+/, '');
    const file = join(ROOT, path);
    if (path.includes('..') || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
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
  for (const file of opts.files) {
    const perWidth = [];
    for (const w of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: w.width, height: 720 } });
      const page = await context.newPage();
      await page.goto(base + file, { waitUntil: 'load' });

      const measured = await page.evaluate(() => {
        const root = document.documentElement;
        const describe = (el) => {
          const rect = el.getBoundingClientRect();
          const label = (el.textContent || '').trim().slice(0, 20) || el.getAttribute('aria-label') || el.tagName.toLowerCase();
          return { el, label, top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right) };
        };
        // 読み順の比較対象は「文字を持つ要素」と「操作できる要素」に限る
        const candidates = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,input,[role]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map(describe);

        // 🔴 画面の外へ追い出した要素は読み順の比較から除外する。
        //   幾何としては左端 -9999px 等の位置を持つため、混ぜると並びの入れ替わりを水増しする。
        const offscreen = candidates.filter((n) => n.right <= 0 || n.left >= window.innerWidth);
        const nodes = candidates
          .filter((n) => !(n.right <= 0 || n.left >= window.innerWidth))
          .map((n, domIndex) => ({ domIndex, label: n.label, top: n.top, left: n.left }));

        // 見た目の読み順: 同じ行（上端の差が 4px 以内）は左から、行が違えば上から
        const visual = [...nodes].sort((a, b) => (Math.abs(a.top - b.top) <= 4 ? a.left - b.left : a.top - b.top));
        const swapped = visual
          .map((n, visualIndex) => ({ ...n, visualIndex }))
          .filter((n) => n.visualIndex !== n.domIndex);

        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          overflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
          countedElements: nodes.length,
          offscreenElements: offscreen.map((n) => ({ label: n.label, left: n.left })),
          swapped: swapped.map((n) => ({ label: n.label, domIndex: n.domIndex, visualIndex: n.visualIndex }))
        };
      });

      perWidth.push({ condition: w.id, label: w.label, viewportWidth: w.width, ...measured });
      await context.close();
    }
    records.push({ engine: engineName, file, conditions: perWidth });
  }
  await browser.close();
}

server.close();

for (const r of records) {
  console.log(r.file + `（${r.engine}）`);
  for (const c of r.conditions) {
    const overflow = c.overflowPx > 0 ? `横あふれ ${c.overflowPx}px` : '横あふれ なし';
    console.log(`  ${c.label}: ${overflow} / 並びの入れ替わり ${c.swapped.length} 件 / 画面外 ${c.offscreenElements.length} 件`);
    for (const s of c.swapped) console.log(`      入れ替わり: 「${s.label}」 DOM ${s.domIndex} 番目 → 見た目 ${s.visualIndex} 番目`);
    for (const o of c.offscreenElements) console.log(`      画面外: 「${o.label}」（left ${o.left}px）`);
  }
}

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify({ tool: 'measure-zoom-reflow', widths: WIDTHS, records }, null, 2) + '\n');
  console.log(`\nwrote ${opts.out}`);
}
