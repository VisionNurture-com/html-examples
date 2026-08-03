// CSS の書き間違いが、どこまで効かなくなるかを測る。
//
//   node tools/measure-css-parse-recovery.mjs
//
// 出力: tools/results/003-parse-error.json
//
// 背景:
//   「CSS が一部だけ効かない」の原因として、競合記事はほぼ全件が「記述ミス（; の打ち忘れ・
//   閉じ括弧漏れ・全角スペース）」を挙げる。ただし挙げるだけで、1 か所の書き間違いが
//   「その 1 行だけを無効にするのか、後ろまで巻き込むのか」を測った記事は確認できなかった。
//   ここでは同じ書き間違いを 3 エンジンに与え、無効になる範囲を実際に数える。
//
// 判定の設計:
//   - 判定は getComputedStyle の実値で行う（規則の暗記ではなく観察で決める）。
//   - 2 つのルール（.one / .two）を並べ、書き間違いのあるルールの後ろが生き残るかを見る。

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'tools', 'results');

const RED = 'rgb(185, 28, 28)';   // #b91c1c
const BODY = '<p class="one" id="one">1 つ目</p><p class="two" id="two">2 つ目</p>';

const doc = (style) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>probe</title>` +
  `<style>${style}</style></head><body>${BODY}</body></html>`;

const CASES = [
  {
    id: 'baseline',
    label: '書き間違いなし（対照）',
    style: '.one { color: #b91c1c; font-size: 20px; }\n.two { color: #b91c1c; }',
  },
  {
    id: 'missing-semicolon',
    label: '1 つ目の宣言の末尾に ; がない',
    style: '.one { color: #b91c1c font-size: 20px; }\n.two { color: #b91c1c; }',
  },
  {
    id: 'missing-closing-brace',
    label: '1 つ目のルールの閉じ括弧がない',
    style: '.one { color: #b91c1c; font-size: 20px;\n.two { color: #b91c1c; }',
  },
  {
    id: 'unknown-property',
    label: 'プロパティ名の綴り違い（colr）',
    style: '.one { colr: #b91c1c; font-size: 20px; }\n.two { color: #b91c1c; }',
  },
  {
    id: 'invalid-value',
    label: '値の書き間違い（# を落とした）',
    style: '.one { color: b91c1c; font-size: 20px; }\n.two { color: #b91c1c; }',
  },
  {
    id: 'ideographic-space',
    label: 'コロンの後ろが全角スペース',
    style: '.one { color:　#b91c1c; font-size: 20px; }\n.two { color: #b91c1c; }',
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
    await p.setContent(doc(c.style), { waitUntil: 'load' });
    const m = await p.evaluate(() => {
      const read = (id) => {
        const s = getComputedStyle(document.getElementById(id));
        return { color: s.color, fontSize: s.fontSize };
      };
      return { one: read('one'), two: read('two') };
    });
    cases.push({
      id: c.id,
      label: c.label,
      one: m.one,
      two: m.two,
      oneColorApplied: m.one.color === RED,
      oneFontSizeApplied: m.one.fontSize === '20px',
      twoColorApplied: m.two.color === RED,
    });
  }
  out[name] = { version: browser.version(), cases };
  await ctx.close();
  await browser.close();
}

const result = {
  scenario: '1 か所の書き間違いが、どの範囲の指定を無効にするか',
  expectedColor: RED,
  engines: out,
  measuredAt: new Date().toISOString(),
  note:
    '判定は getComputedStyle の実値。oneColorApplied / oneFontSizeApplied は書き間違いのある' +
    'ルール自身の 2 宣言、twoColorApplied は後続ルールが生き残ったかを表す。',
};

await mkdir(RESULTS, { recursive: true });
const file = join(RESULTS, '003-parse-error.json');
await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(JSON.stringify(result, null, 2));
