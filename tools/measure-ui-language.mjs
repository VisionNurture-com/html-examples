/**
 * measure-ui-language.mjs — 検証メッセージの「言語」を、ブラウザ UI の言語を変えて測る
 *
 * 使い方:
 *   node tools/measure-ui-language.mjs                      # UI 言語 ja-JP で測る
 *   node tools/measure-ui-language.mjs --ui-locale en-US
 *   node tools/measure-ui-language.mjs --port 9333 --out tools/results/009-ui-language.json
 *
 * なぜ専用スクリプトが必要か:
 *   検証メッセージの言語は `navigator.language`（Playwright の context locale）では
 *   変わらない。ブラウザ UI の言語とローカライズリソースの有無で決まる。
 *
 *   macOS ではさらに Chromium の `--lang` と環境変数 `LANG` が効かず、Cocoa の
 *   `AppleLanguages`（アプリ単位の言語設定）が優先される。そして Playwright の
 *   `launch({ args })` は `-AppleLanguages "(ja-JP)"` を「開くページの指定」と誤認して
 *   拒否する。したがって `open --args` で .app を起動し、CDP（`connectOverCDP`）で接続する。
 *
 *   測定対象は Playwright 同梱の `Google Chrome for Testing.app`（`ja.lproj/locale.pak`
 *   を含む）。`headless: true` の既定で使われる headless shell は翻訳リソースを持たない
 *   ため使えないが、同梱の .app 側を使えばシステムの Chrome には依存しない。
 *
 * 副作用を残さない設計:
 *   専用の `--user-data-dir` を使い、既存プロファイルに触らない。
 *   システム全体やアプリの言語設定を永続変更しない（`defaults write` を使わない）。
 *   測定後にプロセスを終了する。
 *
 * 依存: playwright（devDependencies）+ `npx playwright install chromium`。
 *       `--app` で任意の .app（実機 Google Chrome 等）へ差し替えられる。
 */

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Playwright 同梱の Chromium（Google Chrome for Testing.app）を既定の測定対象にする。
 * システムにインストールされた Chrome に依存せず、`npx playwright install chromium`
 * で取得できるビルドだけで再現できるようにするため。
 *
 * headless shell（`headless: true` の既定）は翻訳リソースを持たないため使えない。
 * 同梱の .app 側には ja.lproj/locale.pak が入っている。
 */
function bundledChromiumApp() {
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort();
  for (const dir of dirs.reverse()) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const app = `${root}/${dir}/${arch}/Google Chrome for Testing.app`;
      if (existsSync(app)) return app;
    }
  }
  return null;
}

function parseArgs(argv) {
  const opts = { uiLocale: 'ja-JP', port: 9333, app: bundledChromiumApp() ?? 'Google Chrome', out: 'tools/results/009-ui-language.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--ui-locale') { opts.uiLocale = value; i += 1; }
    else if (key === '--port') { opts.port = Number(value); i += 1; }
    else if (key === '--app') { opts.app = value; i += 1; }
    else if (key === '--out') { opts.out = value; i += 1; }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const profile = `/tmp/ui-language-probe-${opts.uiLocale}`;
rmSync(profile, { recursive: true, force: true });

spawnSync('open', ['-n', '-a', opts.app, '--args',
  `--remote-debugging-port=${opts.port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '-AppleLanguages', `(${opts.uiLocale})`]);

let browser = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`); break; }
  catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
}
if (!browser) {
  console.error(`CDP 接続に失敗しました（port ${opts.port}）。既に同ポートを使うブラウザが起動していないか確認してください。`);
  process.exit(1);
}

const context = browser.contexts()[0] ?? await browser.newContext();
const page = await context.newPage();
await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ui-language-probe</title></head><body>
<form>
  <input id="valueMissing" required>
  <input id="typeMismatchEmail" type="email" value="not-an-email">
  <input id="typeMismatchUrl" type="url" value="not-a-url">
  <input id="patternMismatch" pattern="[0-9]{3}" value="abc">
  <input id="rangeUnderflow" type="number" min="10" value="1">
  <input id="rangeOverflow" type="number" max="5" value="9">
  <input id="checkboxMissing" type="checkbox" required>
  <input id="radioMissing" type="radio" name="r" required>
  <select id="selectMissing" required><option value="">選択してください</option><option value="a">A</option></select>
</form></body></html>`);

const result = await page.evaluate(() => {
  const ids = ['valueMissing', 'typeMismatchEmail', 'typeMismatchUrl', 'patternMismatch', 'rangeUnderflow', 'rangeOverflow', 'checkboxMissing', 'radioMissing', 'selectMissing'];
  const messages = {};
  for (const id of ids) messages[id] = document.getElementById(id).validationMessage;
  return { messages, navigatorLanguage: navigator.language, navigatorLanguages: Array.from(navigator.languages), userAgent: navigator.userAgent };
});

const payload = {
  tool: 'tools/measure-ui-language.mjs',
  app: opts.app,
  browserVersion: browser.version(),
  uiLocaleRequested: opts.uiLocale,
  mechanism: 'open --args -AppleLanguages "(<locale>)" + CDP 接続。macOS では --lang / LANG が効かず AppleLanguages が優先される',
  result
};

await browser.close();
spawnSync('pkill', ['-f', profile]);

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[${opts.app} ${payload.browserVersion} / ui=${opts.uiLocale}] navigator.language=${result.navigatorLanguage}`);
for (const [key, value] of Object.entries(result.messages)) console.log(`  ${key.padEnd(18)} ${JSON.stringify(value)}`);
console.log(`\nwrote ${opts.out}`);
