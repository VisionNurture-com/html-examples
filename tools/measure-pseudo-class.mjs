/**
 * measure-pseudo-class.mjs — `:invalid` と `:user-invalid` が真になる時点の差を測る
 *
 * 使い方:
 *   node tools/measure-pseudo-class.mjs
 *   node tools/measure-pseudo-class.mjs --engine chromium
 *   node tools/measure-pseudo-class.mjs --out tools/results/009-pseudo-class.json
 *
 * 「初期表示から入力欄が赤くなってしまう」という症状は、どちらの疑似クラスで
 * 色を当てているかで決まる。そこで 4 時点（未操作 / 入力直後 / blur 後 / 送信試行後）
 * のマッチ状態を測り、切り替わる瞬間を特定する。1 時点だけ見ても差は出ない。
 *
 * 計測対象は既存の `compare/009-native-vs-js-validation/a-native.html`。
 * `matches(':invalid')` は CSS 規則がなくても読めるため、疑似クラス比較のための
 * 専用ページは作らない（記事に載らないファイルをリポジトリに増やさないため）。
 * 併せて算出済みの border-color を読み、見た目がいつ変わるかも記録する。
 *
 * 依存: playwright（devDependencies）。ブラウザ本体は `npx playwright install` で取得する。
 */

import { chromium, firefox, webkit } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINES = { chromium, firefox, webkit };
const DEFAULT_ENGINES = ['chromium', 'firefox', 'webkit'];
const TARGET = 'compare/009-native-vs-js-validation/a-native.html';

function parseArgs(argv) {
  const opts = { engines: DEFAULT_ENGINES, out: 'tools/results/009-pseudo-class.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--engine') { opts.engines = [value]; i += 1; }
    else if (key === '--out') { opts.out = value; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

/** email 欄の疑似クラスと算出済み border-color を 1 セット読む */
const probe = (page) => page.evaluate(() => {
  const el = document.getElementById('email');
  return {
    invalid: el.matches(':invalid'),
    valid: el.matches(':valid'),
    userInvalid: el.matches(':user-invalid'),
    userValid: el.matches(':user-valid'),
    borderColor: getComputedStyle(el).borderColor,
  };
});

const opts = parseArgs(process.argv.slice(2));
const url = pathToFileURL(resolve(TARGET)).href;
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const page = await browser.newPage();
  await page.goto(url);

  const stages = {};
  // 1. 未操作（初期表示）。ここで赤くなるかが症状の分かれ目
  stages.initial = await probe(page);

  // 2. 不正な値を入力した直後（フォーカスは email に残る）
  await page.fill('#email', 'abc');
  stages.afterInput = await probe(page);

  // 3. blur 後（他の欄へ移動）
  await page.locator('#tel').focus();
  stages.afterBlur = await probe(page);

  // 4. 送信を試みた後（ブラウザが送信を止める）
  await page.locator('button[type="submit"]').click();
  stages.afterSubmitAttempt = await probe(page);

  records.push({
    engine: engineName,
    browserVersion: browser.version(),
    target: TARGET,
    stages,
  });
  await browser.close();
}

const payload = { measuredAt: new Date().toISOString(), records };
mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);

for (const r of records) {
  console.log(`\n${r.engine} ${r.browserVersion}`);
  for (const [stage, v] of Object.entries(r.stages)) {
    console.log(
      `  ${stage.padEnd(18)} :invalid=${String(v.invalid).padEnd(5)} :user-invalid=${String(v.userInvalid).padEnd(5)} border=${v.borderColor}`,
    );
  }
}
console.log(`\n→ ${opts.out}`);
