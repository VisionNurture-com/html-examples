// 「一部だけ効かない」ときに何が勝っているかを、実際の描画結果で測る。
//
//   node tools/measure-specificity.mjs
//
// 出力: tools/results/003-specificity.json
//
// 測るもの: 同じ要素に複数の指定が当たるとき、どれが採用されるか。
// 判定は getComputedStyle の実値で行う（規則の暗記ではなく観察で決める）。

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'tools', 'results');

const BLUE = 'rgb(29, 78, 216)';    // #1d4ed8
const RED = 'rgb(185, 28, 28)';     // #b91c1c

const page = (style, markup) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>probe</title>` +
  `<style>${style}</style></head><body>${markup}</body></html>`;

// 後に書いた .alert を勝たせたい、という同じ意図を 4 通りの書き方で試す。
const CASES = [
  {
    id: 'id-vs-class',
    label: 'id の指定と class の指定（class を後に書く）',
    style: '#notice { color: #1d4ed8; } .alert { color: #b91c1c; }',
    markup: '<p id="notice" class="alert">対象</p>',
  },
  {
    id: 'class-vs-class',
    label: 'class どうし（後に書いたほうが勝つか）',
    style: '.notice { color: #1d4ed8; } .alert { color: #b91c1c; }',
    markup: '<p class="notice alert">対象</p>',
  },
  {
    id: 'class-order-reversed',
    label: 'class どうし・記述順を入れ替える',
    style: '.alert { color: #b91c1c; } .notice { color: #1d4ed8; }',
    markup: '<p class="notice alert">対象</p>',
  },
  {
    id: 'important-on-class',
    label: 'id の指定に対して class 側に !important を付ける',
    style: '#notice { color: #1d4ed8; } .alert { color: #b91c1c !important; }',
    markup: '<p id="notice" class="alert">対象</p>',
  },
  {
    id: 'inline-vs-important',
    label: 'インラインの style 属性と、class 側の !important',
    style: '.alert { color: #b91c1c !important; }',
    markup: '<p class="alert" style="color: #1d4ed8;">対象</p>',
  },
];

const engines = { chromium, firefox, webkit };
const out = {};

for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const cases = [];
  for (const c of CASES) {
    await p.setContent(page(c.style, c.markup));
    const color = await p.$eval('p', (el) => getComputedStyle(el).color);
    cases.push({
      id: c.id,
      label: c.label,
      computedColor: color,
      winner: color === RED ? '.alert（赤）' : color === BLUE ? '#notice / インライン（青）' : '(その他)',
    });
  }
  out[name] = { version: browser.version(), cases };
  await ctx.close();
  await browser.close();
}

const result = {
  scenario: '同じ要素に複数の指定が当たるとき、どれが採用されるか',
  colors: { blue: BLUE, red: RED },
  engines: out,
  measuredAt: new Date().toISOString(),
  note: '判定は getComputedStyle の実値。規則の暗記ではなく観察で決める',
};

await mkdir(RESULTS, { recursive: true });
const file = join(RESULTS, '003-specificity.json');
await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(JSON.stringify(result, null, 2));
