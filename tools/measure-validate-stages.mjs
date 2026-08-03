/**
 * measure-validate-stages.mjs — 検証をどこに置くかで「検出件数」と「実行時間」がどう変わるかを測る
 *
 * 使い方:
 *   node tools/measure-validate-stages.mjs
 *   node tools/measure-validate-stages.mjs --runs 9
 *   node tools/measure-validate-stages.mjs --out tools/results/010-validate-stages.json
 *
 * 3 段階を、検査するファイルの集合の違いとして測る。
 *
 *   1. エディタのみ  … 開いたファイル 1 本だけ
 *   2. + pre-commit … コミット対象の変更ファイルだけ（フックが git diff --cached で作る一覧）
 *   3. + CI         … 全ファイル
 *
 * 時間は 2 通り測る。理由は、読者が待たされる時間の内訳を分けて示せるようにするため。
 *
 *   cli … 子プロセスとして html-validate を起動する。フックと CI が実際に払うコスト。
 *   api … Node の API を同一プロセス内で呼ぶ。検証そのもののコスト（起動を含まない）。
 *
 * 起動コストが支配的なのかファイル数が支配的なのかは、この 2 つを分けないと言えない。
 *
 * 段階 1 の値は「エディタが検査する範囲を CLI で代替測定したもの」である。
 * エディタ上の体感待ち時間そのものではない（拡張機能は常駐プロセスで動くため）。
 * この違いは結果にも note として記録する。
 *
 * 依存: html-validate（devDependencies）。ブラウザは使わない。
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HtmlValidate } from 'html-validate';

const CONFIG = 'tools/.htmlvalidate.json';
const EDITOR_FILE = 'symptoms/010-markup-errors/broken.html';
const PRECOMMIT_FILES = [
  'symptoms/010-markup-errors/broken.html',
  'symptoms/010-markup-errors/fixed.html',
];
const CORPUS_ROOTS = ['symptoms', 'compare'];

function parseArgs(argv) {
  const opts = { runs: 5, out: 'tools/results/010-validate-stages.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') { opts.runs = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error(`--runs must be a positive integer: ${opts.runs}`);
  return opts;
}

/** 再帰的に .html を集める。node_modules は対象外。 */
function collectHtml(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) out.push(relative(process.cwd(), path));
    }
  };
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return out.sort();
}

/** 中央値。偶数個なら中央 2 つの平均。 */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

const round = (ms) => Math.round(ms * 10) / 10;

/** CLI を 1 回起動し、所要時間と件数を返す。 */
function runCli(files) {
  const started = performance.now();
  const proc = spawnSync('npx', ['--no-install', 'html-validate', '--config', CONFIG, '--formatter', 'json', ...files], {
    encoding: 'utf8',
  });
  const elapsed = performance.now() - started;
  if (proc.error) throw proc.error;
  let errors = null;
  let warnings = null;
  try {
    const report = JSON.parse(proc.stdout);
    errors = report.reduce((sum, r) => sum + r.errorCount, 0);
    warnings = report.reduce((sum, r) => sum + r.warningCount, 0);
  } catch {
    // formatter が JSON を返さなかった場合は件数を null のままにする（推定で埋めない）
  }
  return { elapsed, errors, warnings, exitCode: proc.status };
}

/**
 * CLI と同じ設定を API 側にも読み込ませる。
 *
 * これを渡さないと API は既定設定で走り、CLI（--config 付き）と別の基準で数えてしまう。
 * 実際に初回計測ではこの取り違えで CI 段階の件数が 15 と 21 に割れた。
 * root: true を付けるのは、ファイルの置き場所にある設定を拾って基準がぶれるのを防ぐため。
 */
function loadConfig(path) {
  return { root: true, ...JSON.parse(readFileSync(path, 'utf8')) };
}

/** API を同一プロセスで 1 回呼び、所要時間と件数を返す。 */
async function runApi(files) {
  const htmlvalidate = new HtmlValidate(loadConfig(CONFIG));
  const started = performance.now();
  const report = await htmlvalidate.validateMultipleFiles(files);
  const elapsed = performance.now() - started;
  return { elapsed, errors: report.errorCount, warnings: report.warningCount, valid: report.valid };
}

async function measureStage(name, files, runs, note) {
  const cliRuns = [];
  let cliCounts = null;
  for (let i = 0; i < runs; i += 1) {
    const r = runCli(files);
    cliRuns.push(r.elapsed);
    cliCounts = r;
  }
  const apiRuns = [];
  let apiCounts = null;
  for (let i = 0; i < runs; i += 1) {
    const r = await runApi(files);
    apiRuns.push(r.elapsed);
    apiCounts = r;
  }
  return {
    stage: name,
    note,
    files,
    fileCount: files.length,
    errors: cliCounts.errors,
    warnings: cliCounts.warnings,
    cliExitCode: cliCounts.exitCode,
    apiErrors: apiCounts.errors,
    cliMs: { median: round(median(cliRuns)), min: round(Math.min(...cliRuns)), max: round(Math.max(...cliRuns)), runs: cliRuns.map(round) },
    apiMs: { median: round(median(apiRuns)), min: round(Math.min(...apiRuns)), max: round(Math.max(...apiRuns)), runs: apiRuns.map(round) },
  };
}

const opts = parseArgs(process.argv.slice(2));
const corpus = CORPUS_ROOTS.flatMap(collectHtml);

const stages = [];
stages.push(await measureStage('1-editor-only', [EDITOR_FILE], opts.runs,
  '開いたファイル 1 本。エディタの検査範囲を CLI で代替測定した値であり、エディタ上の体感待ち時間ではない'));
stages.push(await measureStage('2-pre-commit', PRECOMMIT_FILES, opts.runs,
  'フックが git diff --cached で作る一覧を模した固定 2 本。実フックの動作確認は別途 RESULT.md に記録'));
stages.push(await measureStage('3-ci', corpus, opts.runs,
  'symptoms/ と compare/ 配下の全 .html。CI が回す範囲'));

const htmlValidateVersion = spawnSync('npx', ['--no-install', 'html-validate', '--version'], { encoding: 'utf8' }).stdout.trim();

const result = {
  measuredAt: new Date().toISOString(),
  runs: opts.runs,
  env: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    htmlValidate: htmlValidateVersion,
    config: CONFIG,
  },
  stages,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const s of stages) {
  console.log(`${s.stage}: files=${s.fileCount} errors=${s.errors} cli=${s.cliMs.median}ms api=${s.apiMs.median}ms`);
}
console.log(`written: ${opts.out}`);
