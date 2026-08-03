/**
 * measure-keyboard.mjs — Enter キー経路でブラウザの制約検証が働くかを測る
 *
 * 使い方:
 *   node tools/measure-keyboard.mjs <file.html> [<file.html> ...]
 *   node tools/measure-keyboard.mjs --engine webkit symptoms/009-required-novalidate/*.html
 *   node tools/measure-keyboard.mjs --out tools/results/009-keyboard.json <files...>
 *
 * 測るもの:
 *   1. 入力欄で Enter を押したときに submit イベントが発火するか（暗黙の送信）
 *   2. Tab で到達できるフォーカス可能要素の順序
 *   3. 制約違反があるとき、Enter 経路でブラウザの検証が発火を止めるか
 *
 * 数える対象は「submit イベントの発火回数」であり「送信が完了したか」ではない。
 * 自前検証で `preventDefault()` する実装では、発火はしても送信はされない。
 * 「ブラウザの制約検証が Enter 経路で働いたか」を切り分けるための指標である。
 *
 * 測って分かったこと（想定の訂正）:
 *   `type="submit"` の送信ボタンを持たないフォームでも、入力欄での Enter による
 *   暗黙の送信は働いた（chromium 151 実測）。「送信ボタンがないと Enter で送信できない」
 *   という想定は誤りだった。html-validate の wcag/h32 の指摘は、Enter の可否ではなく
 *   「送信手段が明示的に存在すること」を求めるものとして読む必要がある。
 *
 * 依存: playwright（devDependencies）。
 */

import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const records = [];

for (const file of opts.files) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // file: プロトコルに依存せず、内容を直接読み込んで評価する
  await page.setContent(readFileSync(resolve(file), 'utf-8'));

  // 送信の発生を捕捉する。実際の遷移は止め、発生の有無だけを見る
  await page.evaluate(() => {
    window.__submitted = 0;
    document.querySelectorAll('form').forEach((form) => {
      form.addEventListener('submit', (event) => { window.__submitted += 1; event.preventDefault(); });
    });
  });

  const focusOrder = await page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(selector)].map((el) => `${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}${el.id ? `#${el.id}` : ''}`);
  });

  // 空欄のまま Enter: 制約違反があるので送信は止まるべき
  const firstField = await page.$('input:not([type=hidden]), textarea');
  let submitEventOnEnterWhenInvalid = null;
  if (firstField) {
    await firstField.focus();
    await page.keyboard.press('Enter');
    submitEventOnEnterWhenInvalid = await page.evaluate(() => window.__submitted);
  }

  // 正しい値を入れてから Enter: 暗黙の送信が働くか
  let submitEventOnEnterWhenValid = null;
  if (firstField) {
    await page.evaluate(() => {
      window.__submitted = 0;
      document.querySelectorAll('input:not([type=hidden])').forEach((el) => {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = true;
        else if (el.type === 'email') el.value = 'taro@example.com';
        else if (el.type === 'tel') el.value = '09012345678';
        else el.value = '山田太郎';
      });
    });
    await firstField.focus();
    await page.keyboard.press('Enter');
    submitEventOnEnterWhenValid = await page.evaluate(() => window.__submitted);
  }

  const hasSubmitButton = await page.evaluate(() => Boolean(document.querySelector('button[type=submit], input[type=submit], button:not([type])')));

  records.push({ file, engine: opts.engine, browserVersion: browser.version(), hasSubmitButton, focusOrder, submitEventOnEnterWhenInvalid, submitEventOnEnterWhenValid });
  console.log(`${file}`);
  console.log(`  送信ボタン: ${hasSubmitButton ? 'あり' : 'なし'} / Enter（不正時）: submit 発火 ${submitEventOnEnterWhenInvalid} 回 / Enter（正常時）: submit 発火 ${submitEventOnEnterWhenValid} 回`);
  console.log(`  フォーカス順: ${focusOrder.join(' → ')}`);
  await context.close();
}

await browser.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-keyboard.mjs', engine: opts.engine, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
