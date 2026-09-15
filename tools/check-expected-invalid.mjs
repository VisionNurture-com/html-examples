/**
 * check-expected-invalid.mjs — 「意図的に妥当でないサンプル」が本当に妥当でないことを確かめる
 *
 * tools/expected-invalid.tsv に載せたファイルについて、
 *   ① html-validate が実際にエラーを出すこと
 *   ② 出るエラーの rule が一覧の期待と一致すること
 * を確認する。どちらかが崩れたら 1 で終わる。
 *
 * ② まで見るのは、題材を直したのに一覧から外し忘れる／別の違反が紛れ込む、という
 * 逆向きの腐り方を検出するため。①だけだと「別の理由で失敗していれば通る」。
 *
 * 使い方: node tools/check-expected-invalid.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIST = 'tools/expected-invalid.tsv';

const entries = readFileSync(LIST, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [path, rules, reason] = l.split('\t');
    return { path, rules: rules.split(',').sort(), reason };
  });

if (entries.length === 0) {
  console.error(`${LIST} に 1 件も載っていない`);
  process.exit(1);
}

let raw = '';
try {
  raw = execFileSync(
    'npx',
    ['html-validate', '--config', 'tools/.htmlvalidate.json', '--formatter', 'json', ...entries.map((e) => e.path)],
    { encoding: 'utf8' },
  );
  // エラーが 1 件も無ければ html-validate は 0 で返る = 全部が妥当になっている
} catch (err) {
  raw = err.stdout ?? '';
}

const reports = JSON.parse(raw);
const byPath = new Map();
for (const r of reports) {
  const rel = r.filePath.split(`${process.cwd()}/`).pop();
  byPath.set(rel, r);
}

const problems = [];
for (const e of entries) {
  const r = byPath.get(e.path);
  if (!r || (r.errorCount ?? 0) === 0) {
    problems.push(`${e.path}\n    期待: 検証が失敗する（${e.rules.join(',')}）\n    実際: エラー 0 件。題材が直ったなら ${LIST} から外す`);
    continue;
  }
  const actual = [...new Set(r.messages.map((m) => m.ruleId))].sort();
  if (actual.join(',') !== e.rules.join(',')) {
    problems.push(`${e.path}\n    期待する rule: ${e.rules.join(',')}\n    実際の rule  : ${actual.join(',')}`);
  }
}

if (problems.length > 0) {
  console.error(`意図的に妥当でないサンプルの一覧が実態と合っていない（${problems.length} 件）\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`意図どおり ${entries.length} 件すべてが検証に失敗した（rule も一致）`);
