/**
 * measure-validation.mjs — 制約検証 API の挙動と既定メッセージを、エンジンとロケールを変えて測る
 *
 * 使い方:
 *   node tools/measure-validation.mjs
 *   node tools/measure-validation.mjs --engine chromium --locale ja-JP
 *   node tools/measure-validation.mjs --out tools/results/009-constraint-validation.json
 *
 * 既定は chromium / firefox / webkit × en-US / ja-JP の 6 通りを一括実行する。
 *
 * エンジンを 1 つしか測らないと「ブラウザ間で挙動が同じ」とも「ブラウザによって
 * 文言が違う」とも書けない。ロケールを 1 つしか測らないと、文言の差をエンジン差へ
 * 誤って帰属させる。条件軸を分けて測るのはそのためである。
 *
 * 各レコードにエンジン名・ブラウザ版・ロケールを入れる。どの条件で測ったのかを
 * 結果ファイル自身から検算できるようにするため。
 *
 * 依存: playwright（devDependencies）。ブラウザ本体は `npx playwright install` で取得する。
 */

import { chromium, firefox, webkit } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const DEFAULT_ENGINES = ['chromium', 'firefox', 'webkit'];
const DEFAULT_LOCALES = ['en-US', 'ja-JP'];

function parseArgs(argv) {
  const opts = { engines: DEFAULT_ENGINES, locales: DEFAULT_LOCALES, uiLocale: null, out: 'tools/results/009-constraint-validation.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--engine') { opts.engines = [value]; i += 1; }
    else if (key === '--locale') { opts.locales = [value]; i += 1; }
    else if (key === '--ui-locale') { opts.uiLocale = value; i += 1; }
    else if (key === '--channel') { opts.channel = value; i += 1; }
    else if (key === '--out') { opts.out = value; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

/**
 * ブラウザ UI のロケールをエンジン別に指定する起動オプションを返す。
 *
 * 検証メッセージの言語は `navigator.language`（context の locale）ではなく
 * ブラウザ UI のロケールとローカライズリソースの有無で決まる。指定方法は
 * エンジンごとに別で、共通のオプションが存在しない。
 *
 * 同梱ビルドに当該言語のリソースが入っていない場合は指定しても英語のままになる。
 * その「応じなかった」という結果自体が測定対象である。
 */
function uiLocaleLaunchOptions(engineName, uiLocale) {
  if (!uiLocale) return {};
  const posix = uiLocale.replace('-', '_');
  if (engineName === 'chromium') {
    return { args: [`--lang=${uiLocale}`], env: { ...process.env, LANG: `${posix}.UTF-8`, LANGUAGE: uiLocale } };
  }
  if (engineName === 'firefox') {
    return { firefoxUserPrefs: { 'intl.locale.requested': uiLocale }, env: { ...process.env, LANG: `${posix}.UTF-8` } };
  }
  if (engineName === 'webkit') {
    return { env: { ...process.env, LANG: `${posix}.UTF-8`, LANGUAGE: uiLocale, AppleLanguages: `(${uiLocale})` } };
  }
  return {};
}

/**
 * ページ内で実行する観測本体。
 * DOM を都度組み立てて、制約検証 API の状態を同期的に読む。
 * form.submit() はナビゲーションを起こすため、カウンタは呼び出し直後に同期で読む。
 */
function probe() {
  const r = { env: {}, submitPaths: {}, novalidate: {}, formNoValidate: {}, customValidity: {}, checkboxGroup: {}, radioGroup: {}, messages: {}, support: {}, requiredIneffective: {} };
  const build = (html) => { document.body.innerHTML = html; };

  r.env.userAgent = navigator.userAgent;
  r.env.language = navigator.language;
  r.env.languages = Array.from(navigator.languages || []);

  // --- 1. 送信 3 経路で検証が走るか -------------------------------------
  const measurePath = (invoke) => {
    build('<form id="f" method="post"><input type="email" id="e" name="email" required><button type="submit" id="s">送信</button></form>');
    const form = document.getElementById('f');
    const input = document.getElementById('e');
    let submitFired = 0;
    let invalidFired = 0;
    form.addEventListener('submit', (event) => { submitFired += 1; event.preventDefault(); });
    input.addEventListener('invalid', () => { invalidFired += 1; });
    let threw = null;
    try { invoke(form); } catch (err) { threw = `${err.name}: ${err.message}`; }
    return { submitFired, invalidFired, threw };
  };

  r.submitPaths.formSubmit = measurePath((form) => form.submit());
  r.submitPaths.requestSubmit = measurePath((form) => form.requestSubmit());
  r.submitPaths.submitButtonClick = measurePath(() => document.getElementById('s').click());

  // --- 2. novalidate は何を変えるか ------------------------------------
  build('<form id="f" method="post" novalidate><input type="email" id="e" name="email" required><button type="submit">送信</button></form>');
  {
    const form = document.getElementById('f');
    const input = document.getElementById('e');
    let submitFired = 0;
    form.addEventListener('submit', (event) => { submitFired += 1; event.preventDefault(); });
    r.novalidate.checkValidity = form.checkValidity();
    r.novalidate.inputValid = input.validity.valid;
    form.requestSubmit();
    r.novalidate.submitFiredOnRequestSubmit = submitFired;
  }

  // --- 2b. formnovalidate は「押したボタンの分だけ」検証を外すか ---------
  // novalidate はフォーム全体に効く。formnovalidate は送信ボタン側に付ける属性で、
  // そのボタンから送信したときだけ検証を飛ばす。同じフォームに両方のボタンを置き、
  // どちらを押したかで結果が変わるかを測る。
  build('<form id="f" method="post"><input type="email" id="e" name="email" required><button type="submit" id="normal">送信</button><button type="submit" id="skip" formnovalidate>下書き保存</button></form>');
  {
    const form = document.getElementById('f');
    const input = document.getElementById('e');
    const measureClick = (buttonId) => {
      let submitFired = 0;
      let invalidFired = 0;
      const onSubmit = (event) => { submitFired += 1; event.preventDefault(); };
      const onInvalid = () => { invalidFired += 1; };
      form.addEventListener('submit', onSubmit);
      input.addEventListener('invalid', onInvalid);
      document.getElementById(buttonId).click();
      form.removeEventListener('submit', onSubmit);
      input.removeEventListener('invalid', onInvalid);
      return { submitFired, invalidFired };
    };
    r.formNoValidate.normalButtonClick = measureClick('normal');
    r.formNoValidate.formNoValidateButtonClick = measureClick('skip');
    // 検証結果そのものが変わるのか、送信が止まらなくなるだけなのかを分けて見る
    r.formNoValidate.inputValidAfter = input.validity.valid;
    r.formNoValidate.valueMissingAfter = input.validity.valueMissing;
    r.formNoValidate.formCheckValidityAfter = form.checkValidity();
  }

  // --- 3. setCustomValidity の状態遷移 ---------------------------------
  build('<form id="f"><input type="text" id="t" name="t" required><button type="submit">送信</button></form>');
  {
    const form = document.getElementById('f');
    const input = document.getElementById('t');
    const snap = () => ({ message: input.validationMessage, customError: input.validity.customError, formValid: form.checkValidity() });
    input.setCustomValidity('この項目は必須です');
    r.customValidity.afterSet = snap();
    input.value = '入力済み';
    r.customValidity.afterValidInput = snap();
    input.setCustomValidity('');
    r.customValidity.afterReset = snap();
  }

  // --- 4. checkbox 群 ---------------------------------------------------
  build('<form id="f"><input type="checkbox" name="topic" value="a" required><input type="checkbox" name="topic" value="b" required><input type="checkbox" name="topic" value="c" required><button type="submit">送信</button></form>');
  {
    const form = document.getElementById('f');
    const boxes = Array.from(document.querySelectorAll('input[name="topic"]'));
    r.checkboxGroup.allRequired_noneChecked = { formValid: form.checkValidity(), eachValid: boxes.map((b) => b.validity.valid) };
    boxes[0].checked = true;
    r.checkboxGroup.allRequired_oneChecked = { formValid: form.checkValidity(), eachValid: boxes.map((b) => b.validity.valid) };
    boxes.forEach((b) => { b.checked = true; });
    r.checkboxGroup.allRequired_allChecked = { formValid: form.checkValidity() };
    boxes.forEach((b) => { b.checked = false; b.removeAttribute('required'); });
    boxes[0].setAttribute('required', '');
    r.checkboxGroup.oneRequired_noneChecked = { formValid: form.checkValidity() };
    boxes[2].checked = true;
    r.checkboxGroup.oneRequired_otherChecked = { formValid: form.checkValidity() };
  }

  // --- 5. radio 群（checkbox との対比）---------------------------------
  build('<form id="f"><input type="radio" name="plan" value="a" required><input type="radio" name="plan" value="b"><input type="radio" name="plan" value="c"><button type="submit">送信</button></form>');
  {
    const form = document.getElementById('f');
    const radios = Array.from(document.querySelectorAll('input[name="plan"]'));
    r.radioGroup.oneRequired_noneChecked = { formValid: form.checkValidity(), eachValid: radios.map((x) => x.validity.valid) };
    radios[2].checked = true;
    r.radioGroup.oneRequired_otherChecked = { formValid: form.checkValidity(), eachValid: radios.map((x) => x.validity.valid) };
  }

  // --- 6. 既定メッセージの文言 -----------------------------------------
  build('<form id="f"><input type="text" id="t1" required><input type="email" id="t2" value="not-an-email"><input type="text" id="t3" pattern="[0-9]{3}" value="abc"><input type="number" id="t4" min="10" value="1"><input type="text" id="t5" maxlength="3"><button type="submit">送信</button></form>');
  {
    const read = (id) => {
      const el = document.getElementById(id);
      return { message: el.validationMessage, validity: { valueMissing: el.validity.valueMissing, typeMismatch: el.validity.typeMismatch, patternMismatch: el.validity.patternMismatch, rangeUnderflow: el.validity.rangeUnderflow } };
    };
    r.messages.valueMissing = read('t1');
    r.messages.typeMismatch_email = read('t2');
    r.messages.patternMismatch = read('t3');
    r.messages.rangeUnderflow = read('t4');
  }

  // --- 7. サポート状況 --------------------------------------------------
  build('<form id="f"></form>');
  {
    const form = document.getElementById('f');
    r.support.requestSubmit = typeof form.requestSubmit === 'function';
    const supports = (sel) => { try { return CSS.supports(`selector(${sel})`); } catch (e) { return `error: ${e.message}`; } };
    r.support.userInvalid = supports(':user-invalid');
    r.support.userValid = supports(':user-valid');
    r.support.invalid = supports(':invalid');
  }

  // --- 8. required が効かない条件 --------------------------------------
  build('<form id="f"><input type="text" id="d" required disabled><input type="text" id="h" required hidden><input type="hidden" id="ht" required><input type="checkbox" id="c" required><button type="submit">送信</button></form>');
  {
    const form = document.getElementById('f');
    const state = (id) => { const el = document.getElementById(id); return { willValidate: el.willValidate, valid: el.validity.valid, valueMissing: el.validity.valueMissing }; };
    r.requiredIneffective.disabled = state('d');
    r.requiredIneffective.hiddenAttribute = state('h');
    r.requiredIneffective.typeHidden = state('ht');
    r.requiredIneffective.checkboxUnchecked = state('c');
    r.requiredIneffective.formValid = form.checkValidity();
  }

  // --- 8b. readonly / CSS 非表示 / form の外 ----------------------------
  // 「required が効かない」と言われる条件のうち、属性で外れるもの（readonly）と
  // 外れないもの（CSS の display:none）を分けて測る。見た目が同じでも
  // 検証対象かどうかは別で決まるため、両者を並べないと読者が取り違える。
  build('<style>.hid{display:none}</style><form id="f"><input type="text" id="ro" required readonly><input class="hid" type="text" id="cs" required><button type="submit">送信</button></form><input type="text" id="out" required>');
  {
    const form = document.getElementById('f');
    const state = (id) => { const el = document.getElementById(id); return { willValidate: el.willValidate, valid: el.validity.valid, valueMissing: el.validity.valueMissing }; };
    r.requiredIneffective.readonly = state('ro');
    r.requiredIneffective.cssDisplayNone = state('cs');
    // form 属性を持たず <form> の外にある入力欄。要素単体は検証対象だが
    // フォームの所有物ではないため、送信時の判定には入らない。
    r.requiredIneffective.outsideForm = { ...state('out'), formElementsCount: form.elements.length };
    r.requiredIneffective.formValidWithReadonlyAndCssHidden = form.checkValidity();
  }

  return r;
}

const opts = parseArgs(process.argv.slice(2));
const records = [];

for (const engineName of opts.engines) {
  const browserType = ENGINES[engineName];
  // channel を指定すると Playwright 同梱ビルドではなくシステムにインストールされた
  // ブラウザ（例: /Applications/Google Chrome.app）を使う。同梱ビルドは翻訳リソースを
  // 削っていることがあり、UI 言語の実測にはシステム版が必要になる。
  const launchOptions = { ...uiLocaleLaunchOptions(engineName, opts.uiLocale) };
  if (opts.channel) launchOptions.channel = opts.channel;
  const browser = await browserType.launch(launchOptions);
  const version = browser.version();
  for (const locale of opts.locales) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>probe</title></head><body></body></html>');
    const result = await page.evaluate(probe);
    records.push({ engine: engineName, browserVersion: version, channel: opts.channel ?? "bundled", locale, uiLocale: opts.uiLocale ?? "default", result });
    console.log(`[${engineName} ${version} / navigator=${locale} / ui=${opts.uiLocale ?? 'default'}] valueMissing=${JSON.stringify(result.messages.valueMissing.message)}`);
    await context.close();
  }
  await browser.close();
}

const payload = {
  measuredAtNote: '実行時刻は実行ログ側に記録する（本ファイルは再実行で決定論的に同じ内容になるべきものを持つ）',
  tool: 'tools/measure-validation.mjs',
  engines: opts.engines,
  locales: opts.locales,
  uiLocale: opts.uiLocale ?? 'default',
  records
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote ${opts.out} (${records.length} records)`);
