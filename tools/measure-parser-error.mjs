/**
 * measure-parser-error.mjs — トークナイズできない断片が入ると、その後ろの誤りが報告されなくなるのかを測る
 *
 * 使い方:
 *   node tools/measure-parser-error.mjs
 *   node tools/measure-parser-error.mjs --out tools/results/010-parser-error.json
 *
 * 入力中に打ち間違えると、html-validate が parser-error を 1 件出して件数が減ることがある。
 * 偶発的に観察した挙動なので、条件を作って確かめる。
 *
 * 同じファイルから 2 通りを作り、報告されたルール名の集合を比べる。
 *
 *   broken  … 打ち間違いの断片（<<section>>）を含む
 *   control … その 1 行だけを取り除いたもの（他の誤りはそのまま残す）
 *
 * control 側で報告される誤りが broken 側で消えるなら、「壊れた箇所より後ろは解析されない」と言える。
 * 消えないなら、その説明は成り立たない。
 *
 * 依存: html-validate（devDependencies）。
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HtmlValidate } from 'html-validate';

const TARGET = 'symptoms/010-parser-error/broken.html';
const FRAGMENT = '<<section>>';
const CONFIG = 'tools/.htmlvalidate.json';

/** CLI（--config 付き）と同じ基準で数えるため、設定ファイルを明示して読み込む。 */
function loadConfig(path) {
  return { root: true, ...JSON.parse(readFileSync(path, 'utf8')) };
}

function parseArgs(argv) {
  const opts = { out: 'tools/results/010-parser-error.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  return opts;
}

/** 文字列を検証し、件数とルール名・位置を返す。 */
async function validate(htmlvalidate, source, filename) {
  const report = await htmlvalidate.validateString(source, filename);
  const messages = report.results.flatMap((r) => r.messages);
  return {
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    rules: messages.map((m) => `${m.ruleId}@${m.line}:${m.column}`),
    ruleIds: [...new Set(messages.map((m) => m.ruleId))].sort(),
  };
}

const opts = parseArgs(process.argv.slice(2));
const original = readFileSync(TARGET, 'utf8');
const lines = original.split('\n');
const fragmentLineIndex = lines.findIndex((line) => line.includes(FRAGMENT));
if (fragmentLineIndex === -1) throw new Error(`fragment not found in ${TARGET}: ${FRAGMENT}`);
const control = lines.filter((_, i) => i !== fragmentLineIndex).join('\n');

const htmlvalidate = new HtmlValidate(loadConfig(CONFIG));
const broken = await validate(htmlvalidate, original, TARGET);
const controlResult = await validate(htmlvalidate, control, 'control.html');

const lostRules = controlResult.ruleIds.filter((id) => !broken.ruleIds.includes(id));
const truncates = broken.ruleIds.includes('parser-error') && lostRules.length > 0;

const result = {
  measuredAt: new Date().toISOString(),
  target: TARGET,
  fragment: FRAGMENT,
  fragmentLine: fragmentLineIndex + 1,
  env: { node: process.version, platform: process.platform },
  broken,
  control: controlResult,
  lostRulesInBroken: lostRules,
  conclusion: truncates
    ? 'parser-error が出た場合、control で報告される誤りの一部が報告されなくなる（解析の打ち切りと整合）'
    : 'parser-error が出ても、control で報告される誤りは報告され続ける（打ち切りという説明は成り立たない）',
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

console.log(`broken : errors=${broken.errorCount} rules=${broken.ruleIds.join(',')}`);
console.log(`control: errors=${controlResult.errorCount} rules=${controlResult.ruleIds.join(',')}`);
console.log(`lost in broken: ${lostRules.length ? lostRules.join(',') : '(none)'}`);
console.log(result.conclusion);
console.log(`written: ${opts.out}`);
