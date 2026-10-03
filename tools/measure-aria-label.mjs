/**
 * measure-aria-label.mjs — aria-label が見えている文字を上書きしたとき、
 * ボタンの名前がどう計算され、見えている文字で探して見つかるかを測る
 *
 * 使い方:
 *   node tools/measure-aria-label.mjs symptoms/005-aria-label-override/*.html
 *   node tools/measure-aria-label.mjs --engine webkit symptoms/005-aria-label-override/*.html
 *   node tools/measure-aria-label.mjs --text 申し込む --out tools/results/005-aria-label.json <files...>
 *
 * 測るもの（ファイルごと・エンジンごと）:
 *   ① main 配下のアクセシビリティツリー（ariaSnapshot）。ボタンの名前はここに出る
 *   ② 見えている文字（--text・既定は「申し込む」）で getByRole('button', { name }) を引いて見つかる数
 *
 * 🔴 ② は Playwright の既定どおり部分一致で引く。
 *   「申し込む（確認画面へ）」のように見えている文字を含む名前は見つかり、
 *   「送信」のように含まない名前は見つからない。記事が問題にしているのはこの差。
 *
 * 🔴 ここで取れるのはブラウザが計算した名前であり、実機スクリーンリーダーの読み上げとは別の層。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINES = { chromium, firefox, webkit };

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null, text: '申し込む', files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--text') { opts.text = argv[i + 1]; i += 1; }
    else opts.files.push(argv[i]);
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  if (opts.files.length === 0) throw new Error('計測対象の HTML を 1 つ以上指定してください');
  for (const f of opts.files) if (!existsSync(f)) throw new Error(`ファイルがありません: ${f}`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const context = await browser.newContext({ locale: 'ja-JP' });

  for (const file of opts.files) {
    const page = await context.newPage();
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });

    const snapshot = await page.locator('main').ariaSnapshot();
    const foundByVisibleText = await page.getByRole('button', { name: opts.text }).count();

    const record = {
      file,
      engine: engineName,
      browserVersion: browser.version(),
      locale: 'ja-JP',
      visibleText: opts.text,
      snapshot,
      foundByVisibleText,
    };
    records.push(record);
    console.log(`## ${engineName} ${record.browserVersion} — ${file}`);
    console.log(snapshot);
    console.log(`見えている文字「${opts.text}」で探して見つかる数: ${foundByVisibleText}\n`);
    await page.close();
  }
  await browser.close();
}

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`保存しました: ${opts.out}`);
}
