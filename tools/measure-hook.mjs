/**
 * measure-hook.mjs — pre-commit フックが本当にコミットを止めるのかを測る
 *
 * 使い方:
 *   node tools/measure-hook.mjs
 *   node tools/measure-hook.mjs --out tools/results/010-hook.json
 *
 * 測るのは 3 つ。
 *
 *   1. 壊れた HTML を stage して commit すると、終了コードが非ゼロでコミットが作られないか
 *   2. 妥当な HTML だけなら commit が通るか
 *   3. --no-verify を付けると、壊れた HTML でもコミットが作られてしまうか
 *
 * 3 番目まで測るのは、フックが安全網であって関門ではないことを数字で示すため。
 *
 * 作業リポジトリを汚さないよう、一時ディレクトリに新しいリポジトリを作って測る。
 * clone ではなくファイル複製にしているのは、まだコミットしていないサンプルでも測れるようにするため
 * （clone はコミット済みの履歴しか持ってこない）。
 * node_modules は元リポジトリへの symlink で共有する（npx --no-install の解決のため）。
 * 測定後に一時ディレクトリを削除する。
 *
 * 依存: git / node。html-validate は元リポジトリの node_modules を使う。
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, appendFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOOKS_PATH = 'compare/010-validation-stages/githooks';
const BROKEN = 'symptoms/010-markup-errors/broken.html';
const FIXED = 'symptoms/010-markup-errors/fixed.html';
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function parseArgs(argv) {
  const opts = { out: 'tools/results/010-hook.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  return opts;
}

function run(cwd, args, options = {}) {
  const proc = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', ...options });
  if (proc.error) throw proc.error;
  return {
    exitCode: proc.status,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

/** HEAD のコミット数。コミットが作られたかどうかの判定に使う。 */
function commitCount(cwd) {
  return Number(run(cwd, ['git', 'rev-list', '--count', 'HEAD']).stdout);
}

const opts = parseArgs(process.argv.slice(2));
const source = process.cwd();
const workdir = mkdtempSync(join(tmpdir(), 'hook-measure-'));
const repo = join(workdir, 'repo');

const steps = [];
try {
  // 測定に要るファイルだけを複製した、履歴 1 つのリポジトリを作る
  for (const relPath of [BROKEN, FIXED, 'tools/.htmlvalidate.json', `${HOOKS_PATH}/pre-commit`]) {
    mkdirSync(join(repo, dirname(relPath)), { recursive: true });
    copyFileSync(join(source, relPath), join(repo, relPath));
  }
  run(repo, ['chmod', '+x', `${HOOKS_PATH}/pre-commit`]);
  symlinkSync(join(source, 'node_modules'), join(repo, 'node_modules'));
  run(repo, ['git', 'init', '--quiet', '-b', 'main']);
  run(repo, ['git', 'add', '.']);
  run(repo, ['git', ...IDENTITY, 'commit', '--no-verify', '--quiet', '-m', 'measure: baseline']);
  run(repo, ['git', 'config', 'core.hooksPath', HOOKS_PATH]);

  const before = commitCount(repo);

  // 1. 壊れた HTML を含めてコミットする
  appendFileSync(join(repo, BROKEN), '<!-- 測定のための追記 -->\n');
  run(repo, ['git', 'add', BROKEN]);
  const broken = run(repo, ['git', ...IDENTITY, 'commit', '-m', 'measure: broken']);
  const afterBroken = commitCount(repo);
  steps.push({
    step: 'commit-with-broken-html',
    exitCode: broken.exitCode,
    commitCreated: afterBroken > before,
    hookOutputTail: broken.stdout.split('\n').slice(-3).concat(broken.stderr.split('\n').slice(-3)).filter(Boolean),
  });

  // 2. --no-verify で同じコミットを試す
  const bypass = run(repo, ['git', ...IDENTITY, 'commit', '--no-verify', '-m', 'measure: broken with --no-verify']);
  const afterBypass = commitCount(repo);
  steps.push({
    step: 'commit-with-broken-html-and-no-verify',
    exitCode: bypass.exitCode,
    commitCreated: afterBypass > afterBroken,
  });

  // 3. 妥当な HTML だけでコミットする
  appendFileSync(join(repo, FIXED), '<!-- 測定のための追記 -->\n');
  run(repo, ['git', 'add', FIXED]);
  const clean = run(repo, ['git', ...IDENTITY, 'commit', '-m', 'measure: fixed only']);
  const afterClean = commitCount(repo);
  steps.push({
    step: 'commit-with-valid-html',
    exitCode: clean.exitCode,
    commitCreated: afterClean > afterBypass,
  });

  const gitVersion = run(repo, ['git', '--version']).stdout;
  const result = {
    measuredAt: new Date().toISOString(),
    env: { node: process.version, platform: process.platform, arch: process.arch, git: gitVersion },
    hooksPath: HOOKS_PATH,
    steps,
  };

  mkdirSync(dirname(resolve(source, opts.out)), { recursive: true });
  writeFileSync(resolve(source, opts.out), `${JSON.stringify(result, null, 2)}\n`);

  for (const s of steps) {
    console.log(`${s.step}: exit=${s.exitCode} commitCreated=${s.commitCreated}`);
  }
  console.log(`written: ${opts.out}`);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
