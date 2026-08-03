/**
 * measure-rule-sets.mjs — 各手段が持っているルールの集合を数え、重なりと差を出す
 *
 * 使い方:
 *   node tools/measure-rule-sets.mjs
 *   node tools/measure-rule-sets.mjs --out tools/results/006-rule-sets.json
 *
 * 測るもの:
 *   1. axe-core が持つルールの総数と、WCAG の達成基準に紐づくルールの数
 *   2. Lighthouse の accessibility カテゴリが持つ監査項目の総数と内訳（採点対象 / 人が確認）
 *   3. 両者の ID を突き合わせた集合（両方にある / axe だけ / Lighthouse だけ）
 *
 * 集合を数える理由:
 *   Lighthouse の公式ドキュメントは「重みは axe の影響度評価に基づく」と書くが、
 *   axe のルールをすべて回すとは書いていない。どちらにしか無い項目があるかどうかは
 *   利用者側で数えないと分からない。ページの中身に依存しない「持っているルール」の
 *   比較なので、題材ページとは別に 1 回だけ測る。
 *
 * 数え方の注意:
 *   axe は getRules() が返す総数と、1 ページの評価で結果に現れる数が一致しない
 *   （そのページに対象の要素が無いルールは inapplicable として現れる）。ここでは
 *   「持っているルールの総数」を getRules() で数える。
 *
 *   適合レベル別の合計は、達成基準に紐づくルールの数と一致しない。レベルのタグが
 *   wcag2a ではなく wcag2a-obsolete になっているルールがあるためで、集計の取りこぼしではなく
 *   axe 側の分類の実態にあたる。規格から削除された達成基準に紐づくルールがどれかを
 *   読者が自分で確かめられるよう、obsolete 側も分けて出す。
 *
 * 依存: playwright / axe-core / lighthouse（すべて devDependencies）
 */

import { chromium } from 'playwright';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const AXE_VERSION = require('axe-core/package.json').version;
const LH_VERSION = require('lighthouse/package.json').version;

const outIndex = process.argv.indexOf('--out');
const out = outIndex === -1 ? null : process.argv[outIndex + 1];

// --- axe-core が持つルール ---
process.env.CHROME_PATH ??= chromium.executablePath();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: readFileSync(AXE_PATH, 'utf-8') });
const axeRules = await page.evaluate(() => window.axe.getRules().map((r) => ({ id: r.ruleId, tags: r.tags })));
await browser.close();

const isSC = (t) => /^wcag[0-9]{3,4}$/.test(t);
const axeIds = new Set(axeRules.map((r) => r.id));
const axeWcagIds = new Set(axeRules.filter((r) => r.tags.some(isSC)).map((r) => r.id));
const axeSC = new Set(axeRules.flatMap((r) => r.tags.filter(isSC)));
const isLevel = (t) => /^wcag2{0,1}[0-9]?(a|aa|aaa)$/.test(t);
const isObsoleteLevel = (t) => /^wcag2{0,1}[0-9]?(a|aa|aaa)-obsolete$/.test(t);
const axeLevels = {};
for (const r of axeRules) {
  for (const t of r.tags) {
    if (isLevel(t)) axeLevels[t] = (axeLevels[t] ?? 0) + 1;
  }
}
const axeLevelTotal = Object.values(axeLevels).reduce((a, b) => a + b, 0);

// 規格から削除された達成基準に紐づくルール（レベルのタグが -obsolete になっているもの）。
// レベル別の合計が達成基準に紐づくルール数と一致しない差は、ここに出るルールで説明できる。
const obsoleteLevelRules = axeRules
  .filter((r) => r.tags.some(isObsoleteLevel))
  .map((r) => ({
    id: r.id,
    levelTags: r.tags.filter(isObsoleteLevel),
    successCriteria: r.tags.filter(isSC),
    deprecated: r.tags.includes('deprecated')
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

// 非推奨の印が付いたルール。上記より広く、現行のレベルのタグを持ったままのものも含む
// （非推奨であることと、紐づく達成基準が削除されたことは別の話にあたる）。
const deprecatedRules = axeRules
  .filter((r) => r.tags.includes('deprecated'))
  .map((r) => ({
    id: r.id,
    levelTags: r.tags.filter((t) => isLevel(t) || isObsoleteLevel(t)),
    successCriteria: r.tags.filter(isSC)
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

// --- Lighthouse が持つ監査項目（中身に依存しない一覧を取るため最小ページに対して 1 回実行） ---
// Lighthouse 13.4.1 は file:// も data: も受け付けない（どちらも normalizeUrl で INVALID_URL）。
// http(s) のみ通るため、最小ページを配るローカルサーバを立てて測る。
const MINIMAL_PAGE = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>最小ページ</title></head><body><main><h1>最小ページ</h1></main></body></html>';
const { server, port } = await new Promise((res) => {
  const s = createServer((req, resp) => {
    resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(MINIMAL_PAGE);
  });
  s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
});

const chrome = await launch({ chromeFlags: ['--headless=new'] });
const lh = await lighthouse(`http://127.0.0.1:${port}/`, {
  port: chrome.port, output: 'json', onlyCategories: ['accessibility'], logLevel: 'error'
});
await chrome.kill();
server.close();

const cat = lh.lhr.categories.accessibility;
const audits = lh.lhr.audits;
const lhRefs = cat.auditRefs.map((r) => ({ id: r.id, weight: r.weight, mode: audits[r.id]?.scoreDisplayMode ?? null }));
const lhScored = lhRefs.filter((r) => r.mode !== 'manual');
const lhManual = lhRefs.filter((r) => r.mode === 'manual');
const lhScoredIds = new Set(lhScored.map((r) => r.id));

// --- 集合演算（採点対象の監査項目 ⟷ axe のルール ID）---
const both = [...lhScoredIds].filter((id) => axeIds.has(id)).sort();
const lhOnly = [...lhScoredIds].filter((id) => !axeIds.has(id)).sort();
const axeOnly = [...axeIds].filter((id) => !lhScoredIds.has(id)).sort();

const summary = {
  axe: {
    version: AXE_VERSION,
    ruleTotal: axeIds.size,
    wcagTagged: axeWcagIds.size,
    nonWcag: axeIds.size - axeWcagIds.size,
    successCriteriaKinds: axeSC.size,
    levelCounts: axeLevels,
    levelTaggedTotal: axeLevelTotal,
    obsoleteLevelTagged: obsoleteLevelRules.length,
    deprecatedTagged: deprecatedRules.length
  },
  lighthouse: { version: LH_VERSION, auditRefTotal: lhRefs.length, scored: lhScored.length, manual: lhManual.length },
  overlap: { bothCount: both.length, lighthouseOnlyCount: lhOnly.length, axeOnlyCount: axeOnly.length }
};

console.log(`axe-core ${AXE_VERSION}`);
console.log(`  持っているルール      : ${summary.axe.ruleTotal}（WCAG 紐づき ${summary.axe.wcagTagged} / WCAG 外 ${summary.axe.nonWcag}）`);
console.log(`  紐づく達成基準の種類  : ${summary.axe.successCriteriaKinds}`);
console.log(`  適合レベル別          : ${JSON.stringify(axeLevels)}（合計 ${axeLevelTotal}）`);
console.log(`  削除された基準のルール: ${obsoleteLevelRules.length}  ${obsoleteLevelRules.map((r) => `${r.id}（${r.successCriteria.join('/')}）`).join(', ') || '（なし）'}`);
console.log(`  非推奨の印つき        : ${deprecatedRules.length}  ${deprecatedRules.map((r) => r.id).join(', ') || '（なし）'}`);
console.log(`Lighthouse ${LH_VERSION}`);
console.log(`  accessibility の監査項目: ${summary.lighthouse.auditRefTotal}（採点対象 ${summary.lighthouse.scored} / 人が確認 ${summary.lighthouse.manual}）`);
console.log('突き合わせ（採点対象の監査項目 ⟷ axe のルール ID）');
console.log(`  両方にある            : ${summary.overlap.bothCount}`);
console.log(`  Lighthouse だけ       : ${summary.overlap.lighthouseOnlyCount}  ${lhOnly.join(', ') || '（なし）'}`);
console.log(`  axe だけ              : ${summary.overlap.axeOnlyCount}`);

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    tool: 'tools/measure-rule-sets.mjs',
    note: 'Lighthouse の監査項目一覧は中身に依存しないため、最小の HTML に対して 1 回実行して取得した。人が確認する項目（manual）は採点対象から除いて突き合わせている。適合レベル別の合計（levelTaggedTotal）が達成基準に紐づくルール数（wcagTagged）と一致しないのは、レベルのタグが -obsolete になっているルールがあるためで、その内訳は obsoleteLevelRules に出している。deprecatedRules はより広く、現行のレベルのタグを持ったまま非推奨の印が付いたルールも含む',
    summary,
    obsoleteLevelRules,
    deprecatedRules,
    lighthouseManualIds: lhManual.map((r) => r.id).sort(),
    lighthouseOnlyIds: lhOnly,
    axeOnlyIds: axeOnly,
    bothIds: both
  }, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}
