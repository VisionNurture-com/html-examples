// 「採用されているのに見た目が変わらない」状態を測る。
//
//   node tools/measure-applied-no-effect.mjs
//
// 出力: tools/results/003-applied-no-effect.json
//
// 背景:
//   「一部だけ効かない」の切り分けは、打ち消し線の有無で「負けている / 当たっていない」の
//   2 つに分けられることが多い。しかし実際には第 3 の状態がある。
//   同じプロパティを指定している別のルールが存在せず（＝打ち消されず）、計算値もその値に
//   なっているのに、見た目が変わらない場合である。ここではその状態を実際に作って測る。
//
// 判定の設計:
//   - 「採用されているか」は getComputedStyle の実値で判定する。
//   - 「見た目が変わったか」は描画結果で判定する（スクロール後の位置 / 重なり順）。
//   - Chromium では CDP の CSS.getMatchedStylesForNode で、当該プロパティを宣言している
//     ルールが 1 件だけであること（＝打ち消す相手がいないこと）も併せて記録する。

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'tools', 'results');

const doc = (style, body) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>probe</title>` +
  `<style>body{margin:0}${style}</style></head><body>${body}</body></html>`;

// --- ケース 1: 親の overflow が visible 以外だと position: sticky が止まらない ---
const STICKY_BODY =
  '<div class="wrap"><div class="sticky" id="t">見出し</div><div class="spacer"></div></div>';
const STICKY_STYLE = (wrap) =>
  `.wrap{${wrap}}.sticky{position:sticky;top:0;height:40px;background:#1d4ed8}.spacer{height:1500px}`;

// --- ケース 2: 位置指定のない要素の z-index は重なり順に効かない ---
const ZINDEX_BODY = '<div class="a" id="a"></div><div class="b" id="b"></div>';
const ZINDEX_STYLE = (aPosition) =>
  `.a{${aPosition}width:100px;height:100px;background:#b91c1c;z-index:999}` +
  `.b{position:relative;top:-50px;width:100px;height:100px;background:#1d4ed8}`;

const CASES = [
  {
    id: 'sticky-in-overflow-hidden',
    label: '親に overflow: hidden がある要素の position: sticky',
    expectation: '止まらない（採用はされている）',
    html: doc(STICKY_STYLE('overflow:hidden'), STICKY_BODY),
    async measure(page) {
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(50);
      return page.evaluate(() => {
        const el = document.getElementById('t');
        return {
          computed: getComputedStyle(el).position,
          topAfterScroll: Math.round(el.getBoundingClientRect().top),
        };
      });
    },
    verdict: (m) => ({ applied: m.computed === 'sticky', visibleEffect: m.topAfterScroll === 0 }),
  },
  {
    id: 'sticky-control',
    label: '同じ指定・親の overflow を外した対照',
    expectation: '止まる',
    html: doc(STICKY_STYLE(''), STICKY_BODY),
    async measure(page) {
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(50);
      return page.evaluate(() => {
        const el = document.getElementById('t');
        return {
          computed: getComputedStyle(el).position,
          topAfterScroll: Math.round(el.getBoundingClientRect().top),
        };
      });
    },
    verdict: (m) => ({ applied: m.computed === 'sticky', visibleEffect: m.topAfterScroll === 0 }),
  },
  {
    id: 'zindex-on-static',
    label: '位置指定のない要素に z-index: 999',
    expectation: '重なり順は変わらない（採用はされている）',
    html: doc(ZINDEX_STYLE(''), ZINDEX_BODY),
    async measure(page) {
      return page.evaluate(() => ({
        computed: getComputedStyle(document.getElementById('a')).zIndex,
        frontElementId: document.elementFromPoint(50, 75)?.id ?? null,
      }));
    },
    verdict: (m) => ({ applied: m.computed === '999', visibleEffect: m.frontElementId === 'a' }),
  },
  {
    id: 'zindex-control',
    label: '同じ指定・position: relative を足した対照',
    expectation: '重なり順が変わる',
    html: doc(ZINDEX_STYLE('position:relative;'), ZINDEX_BODY),
    async measure(page) {
      return page.evaluate(() => ({
        computed: getComputedStyle(document.getElementById('a')).zIndex,
        frontElementId: document.elementFromPoint(50, 75)?.id ?? null,
      }));
    },
    verdict: (m) => ({ applied: m.computed === '999', visibleEffect: m.frontElementId === 'a' }),
  },
];

/** Chromium のみ: 当該プロパティを宣言しているルールが何件あるかを CDP で数える。 */
async function countDeclaringRules(page, selector, property) {
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId });
  const count = (matched.matchedCSSRules ?? []).filter((r) =>
    (r.rule.style?.cssProperties ?? []).some((p) => p.name === property && !p.disabled),
  ).length;
  await client.detach();
  return count;
}

const engines = { chromium, firefox, webkit };
const out = {};

for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const p = await ctx.newPage();
  const cases = [];
  for (const c of CASES) {
    await p.setContent(c.html, { waitUntil: 'load' });
    const measured = await c.measure(p);
    const v = c.verdict(measured);
    const row = { id: c.id, label: c.label, expectation: c.expectation, ...measured, ...v };
    if (name === 'chromium') {
      const target = c.id.startsWith('sticky') ? { sel: '.sticky', prop: 'position' } : { sel: '.a', prop: 'z-index' };
      row.declaringRuleCount = await countDeclaringRules(p, target.sel, target.prop);
    }
    cases.push(row);
  }
  out[name] = { version: browser.version(), cases };
  await ctx.close();
  await browser.close();
}

const result = {
  scenario: '打ち消されておらず計算値にも反映されているのに、見た目が変わらない指定',
  engines: out,
  measuredAt: new Date().toISOString(),
  note:
    'applied = getComputedStyle が指定どおりの値を返したか / visibleEffect = 描画結果が変わったか。' +
    'declaringRuleCount は Chromium の CDP で数えた「当該プロパティを宣言しているルールの件数」で、' +
    '1 なら打ち消す相手が存在しない（開発者ツールで打ち消し線が付かない）ことを意味する。',
};

await mkdir(RESULTS, { recursive: true });
const file = join(RESULTS, '003-applied-no-effect.json');
await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(JSON.stringify(result, null, 2));
