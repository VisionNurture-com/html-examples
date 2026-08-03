/**
 * measure-a11y.mjs — axe-core の violations と accessibility tree を測る
 *
 * 使い方:
 *   node tools/measure-a11y.mjs <file.html> [<file.html> ...]
 *   node tools/measure-a11y.mjs --engine webkit --out tools/results/009-a11y.json <files...>
 *
 * 測るもの:
 *   1. axe-core の violations（ルール ID・影響度・該当要素数）
 *   2. accessibility tree のスナップショット（role / name / 状態）
 *
 * accessibility tree を併せて取る理由:
 *   axe の violations は「既知のルールに反したか」しか示さない。violations 0 件でも
 *   支援技術に意図と違う形で見えている場合があるため、ブラウザが要素をどう解釈して
 *   いるかを別に記録する。
 *
 * 🔴 訂正（2026-07-31・html-basics 005）:
 *   本コメントは当初「読み上げの実文言は自動取得できないため、実機のスクリーンリーダー
 *   確認は別途手動で行う」と書いていたが、これは誤り。macOS の VoiceOver は AppleScript の
 *   `content of last phrase` で逐語を取得できる（002 で確定 / 005 で 6 実装の逐語を取得）。
 *   手順と必要な環境は tools/measure-voiceover.applescript にある。
 *   ただし本ハーネスが返すのは「ブラウザが構築したアクセシビリティツリーの表現」であり、
 *   実機スクリーンリーダーの読み上げとは別の層である点は変わらない。混ぜて論じない。
 *
 * 依存: playwright / axe-core（devDependencies）。
 */

import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const AXE_VERSION = require('axe-core/package.json').version;
const ENGINES = { chromium, firefox, webkit };

function parseArgs(argv) {
  const opts = { engine: 'chromium', out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--engine') { opts.engine = value; i += 1; }
    else if (key === '--out') { opts.out = value; i += 1; }
    else opts.files.push(key);
  }
  if (!ENGINES[opts.engine]) throw new Error(`unknown engine: ${opts.engine}`);
  if (opts.files.length === 0) throw new Error('測定対象の HTML ファイルを 1 つ以上指定してください');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const browser = await ENGINES[opts.engine].launch();
const axeSource = readFileSync(AXE_PATH, 'utf-8');
const records = [];

for (const file of opts.files) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(readFileSync(resolve(file), 'utf-8'));
  await page.addScriptTag({ content: axeSource });

  const axeResult = await page.evaluate(async () => {
    const run = await window.axe.run(document, { resultTypes: ['violations'] });
    return {
      violations: run.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
      violationCount: run.violations.length,
      affectedNodeCount: run.violations.reduce((sum, v) => sum + v.nodes.length, 0)
    };
  });

  // accessibility tree（フォーム関連要素のみ・role / name / 状態）
  const tree = await page.evaluate(() => {
    const selector = 'form, fieldset, legend, label, input:not([type=hidden]), select, textarea, button, [role]';
    return [...document.querySelectorAll(selector)].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      role: el.getAttribute('role'),
      accessibleName: el.labels?.[0]?.textContent?.trim() || el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24) || null,
      required: el.required ?? null,
      ariaInvalid: el.getAttribute('aria-invalid'),
      ariaDescribedby: el.getAttribute('aria-describedby'),
      ariaLive: el.getAttribute('aria-live')
    }));
  });

  records.push({ file, engine: opts.engine, browserVersion: browser.version(), axeVersion: AXE_VERSION, ...axeResult, accessibilityTree: tree });
  console.log(`${file}`);
  console.log(`  axe violations: ${axeResult.violationCount} 件（該当要素 ${axeResult.affectedNodeCount} 個）`);
  for (const v of axeResult.violations) console.log(`    - ${v.id} [${v.impact}] × ${v.nodes}: ${v.help}`);
  await context.close();
}

await browser.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-a11y.mjs', engine: opts.engine, axeVersion: AXE_VERSION, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
