/**
 * measure-render.mjs — 仕様上は不正なマークアップが、ブラウザでは表示できてしまうのかを測る
 *
 * 使い方:
 *   node tools/measure-render.mjs
 *   node tools/measure-render.mjs --engine chromium
 *   node tools/measure-render.mjs --out tools/results/010-render.json
 *
 * 「表示できているから正しいとは限らない」という主張は、実際に表示できることを
 * 測らないと書けない。html-validate が 11 件を挙げるファイルをブラウザで開き、
 * 見出しと本文が読める状態かどうかを DOM とレイアウトから確かめる。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。1 エンジンの結果から
 * 「ブラウザは表示できる」と一般化できないため。
 *
 * 依存: playwright（devDependencies）。ブラウザ本体は `npx playwright install` で取得する。
 */

import { chromium, firefox, webkit } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const TARGETS = [
  { name: 'broken', path: 'symptoms/010-markup-errors/broken.html' },
  { name: 'fixed', path: 'symptoms/010-markup-errors/fixed.html' },
];

function parseArgs(argv) {
  const opts = { engines: ['chromium', 'firefox', 'webkit'], out: 'tools/results/010-render.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

/**
 * ページ内で読める状態かを観測する。
 * 「表示できる」を目視ではなく、テキストが取れるか + 領域を持つか で判定する。
 */
function probe() {
  const visible = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return { present: false };
    const rect = el.getBoundingClientRect();
    return {
      present: true,
      text: (el.textContent || '').trim().slice(0, 40),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      rendered: rect.width > 0 && rect.height > 0,
    };
  };
  return {
    title: document.title,
    h1: visible('h1'),
    firstParagraph: visible('p'),
    listItem: visible('ul li'),
    link: visible('a'),
    // 重複 id は「先に出てきた要素だけが取れる」ことの確認に使う
    idLeadCount: document.querySelectorAll('#lead').length,
    paragraphCount: document.querySelectorAll('p').length,
    imageCount: document.querySelectorAll('img').length,
    // 壊れたマークアップが DOM でどう補われたかを見る
    bodyChildTags: Array.from(document.body.children).map((el) => el.tagName.toLowerCase()),
  };
}

const opts = parseArgs(process.argv.slice(2));
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const version = browser.version();
  for (const target of TARGETS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`${err.name}: ${err.message}`));
    await page.goto(`file://${resolve(target.path)}`);
    const observed = await page.evaluate(probe);
    records.push({ engine: engineName, engineVersion: version, target: target.name, path: target.path, observed, consoleErrors });
    await context.close();
  }
  await browser.close();
}

const result = {
  measuredAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  note: '「表示できる」の判定は、テキストが取得できて領域が 0 でないこと。目視ではない',
  records,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const r of records) {
  const o = r.observed;
  console.log(`${r.engine} ${r.engineVersion} / ${r.target}: h1="${o.h1.text}" rendered=${o.h1.rendered} p=${o.paragraphCount} #lead=${o.idLeadCount} bodyChildren=${o.bodyChildTags.join('>')} consoleErrors=${r.consoleErrors.length}`);
}
console.log(`written: ${opts.out}`);
