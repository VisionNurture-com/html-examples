#!/usr/bin/env node
// 追跡ファイルに「実行したマシンのホームディレクトリの絶対パス」が残っていないかを検査する。
//
// 計測ハーネスは実行時のパスをそのまま生ログへ書く。放っておくと、
// 測った人のホームディレクトリ名がリポジトリに残り続ける。
// 生ログの値としては「どのファイルを測ったか」「どの版で測ったか」が残ればよく、
// ホームディレクトリ名は情報を持たない。置き換え方は下の PLACEHOLDERS を参照。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 個人を指さないアカウント名。
// `ubuntu` は仮想マシンの既定アカウントで、誰が動かしても同じ名前になる。
const GENERIC_ACCOUNTS = new Set(['ubuntu', 'runner', 'root', 'vagrant']);

const PATTERNS = [
  { re: /\/Users\/([A-Za-z0-9._-]+)\//g, label: 'macOS のホーム' },
  { re: /\/home\/([A-Za-z0-9._-]+)\//g, label: 'Linux のホーム' },
  { re: /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g, label: 'Windows のホーム' },
];

// 置き換えの目安（生ログを直すときはこの形に畳む）
const PLACEHOLDERS = [
  'リポジトリ内のファイル   → リポジトリ相対パス（例: symptoms/010-markup-errors/logo.png）',
  'file:// の URL          → file://<REPO>/…',
  'Playwright のキャッシュ  → <PLAYWRIGHT_CACHE>/…',
  'mise の installs        → <MISE_INSTALLS>/…',
  'Windows のホーム         → <WIN_HOME>/…',
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const findings = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // バイナリや読めないものは対象外
  }
  const lines = text.split('\n');
  for (const { re, label } of PATTERNS) {
    for (const [i, line] of lines.entries()) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (GENERIC_ACCOUNTS.has(m[1])) continue;
        findings.push({ file, line: i + 1, label, hit: m[0] });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`✅ ホームディレクトリの絶対パスなし（追跡ファイル ${files.length} 本）`);
  process.exit(0);
}

console.error(`❌ ホームディレクトリの絶対パスが ${findings.length} 件残っています\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.label}  ${f.hit}`);
}
console.error('\n置き換えの目安:');
for (const p of PLACEHOLDERS) console.error(`  ${p}`);
console.error(
  '\n個人を指さないアカウント名（ubuntu / runner / root / vagrant）は除外済みです。' +
    '\n新しく除外したい場合は tools/check-no-home-paths.mjs の GENERIC_ACCOUNTS に足してください。',
);
process.exit(1);
