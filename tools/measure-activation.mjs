/**
 * measure-activation.mjs — 同じ見た目の 4 実装が、どの操作で起動するかを測る
 *
 * 使い方:
 *   node tools/measure-activation.mjs
 *   node tools/measure-activation.mjs --engine firefox
 *   node tools/measure-activation.mjs --out tools/results/002-activation.json
 *
 * 測るもの: compare/002-a-vs-button-vs-div/index.html の 4 実装それぞれについて
 *   ① Tab キーだけで到達できるか（実際に Tab を押して document.activeElement を見る）
 *   ② マウスのクリックで移動するか
 *   ③ Enter キーで移動するか
 *   ④ Space キーで移動するか
 *   ⑤ 支援技術に伝わる役割と名前（computed role / accessible name）
 *   ⑥ 移動後に history.length が増えるか（戻るボタンで戻れるか）
 *
 * 🔴 到達可否を「セレクタに一致するか」で数えない。
 *   `a[href], button, [tabindex]` のような静的セレクタで数えると、実際の Tab 順序ではなく
 *   「その定義に当てはまるか」を測ることになる。ここでは Tab を実際に押して測る。
 *
 * 🔴 差が出なかった操作も記録する。
 *   マウス操作は 4 実装とも同じ結果になるはずで、その「差が出ないこと」自体が、
 *   この問題が見過ごされる理由である。結果から省かない。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'compare/002-a-vs-button-vs-div';
const TARGETS = [
  { id: 'impl-a', label: 'a href' },
  { id: 'impl-button', label: 'button + script' },
  { id: 'impl-div', label: 'div onclick' },
  { id: 'impl-div-patched', label: 'div + role/tabindex/keydown' }
];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  return opts;
}

// file: では history と別タブの挙動が実環境と揃わないため、簡易 HTTP で配信する
function startServer() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0]));
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Tab を押していき、対象 id に到達するまでの回数を返す。到達しなければ null
 *  あわせて「Tab がそもそも何かに到達したか」も返す。
 *  🔴 Tab が 1 つも動かない環境（macOS の全キーボードアクセスが無効なときの WebKit 等）では、
 *     「この要素に到達しない」ではなく「Tab 走査を測れない」と読む必要がある。
 */
async function tabStopsUntil(page, id, limit = 12) {
  await page.evaluate(() => document.activeElement?.blur?.());
  const sequence = [];
  let movedAtAll = false;
  let stops = null;
  for (let i = 1; i <= limit; i += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? null);
    sequence.push(active);
    if (active && active !== 'BODY') movedAtAll = true;
    if (active === id && stops === null) stops = i;
  }
  // 観測した Tab の並び自体を残す。「到達しない」が要素の性質なのか環境の設定なのかは、
  // 並びを見ないと判断できない（webkit はこの環境で input と tabindex 明示要素にしか止まらない）
  return { stops, movedAtAll, sequence };
}

/** 指定の操作を行い、URL が移動したかを返す
 *  🔴 history.length を測るため、呼び出しごとに新しいコンテキストで開く。
 *     同じページを使い回すと履歴が積み上がり、絶対値が読めなくなる（測定対象の取り違え）。
 */
async function activate(page, url, id, how) {
  await page.goto(url, { waitUntil: 'load' });
  const before = page.url();
  const historyBefore = await page.evaluate(() => history.length);

  if (how === 'mouse') {
    await page.click(`#${id}`);
  } else {
    // 🔴 キーを押す前に、フォーカスが対象そのものに載っていることを必ず確かめる。
    //   確かめずに押すと、直前の Tab 走査で別の要素に載ったフォーカスを起動してしまい、
    //   「到達できないはずの要素がキーで動いた」という存在しない差が出る。
    //   （初版はこの検算がなく、firefox で div が Enter / Space で動いたように見えていた）
    const focusedOnTarget = await page.evaluate((target) => {
      document.activeElement?.blur?.();
      document.getElementById(target)?.focus();
      return document.activeElement?.id === target;
    }, id);
    if (!focusedOnTarget) {
      return { navigated: null, reason: 'フォーカスを載せられないためキー操作を測れない', url: before, historyBefore, historyAfter: historyBefore };
    }
    await page.keyboard.press(how === 'enter' ? 'Enter' : 'Space');
  }

  await page.waitForTimeout(300);
  const after = page.url();
  const historyAfter = await page.evaluate(() => history.length);
  return { navigated: before !== after, url: after, historyBefore, historyAfter };
}

const opts = parseArgs(process.argv.slice(2));
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();

  for (const target of TARGETS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });

    const tab = await tabStopsUntil(page, target.id);
    // Tab が 1 つも動かない環境では、到達可否そのものを測れていない
    const tabStops = tab.stops;
    const tabVerdict = tab.movedAtAll
      ? (tab.stops === null ? '到達しない' : `${tab.stops} 回目で到達`)
      : '測定不能（この環境では Tab がどの要素にも移らない）';
    // 参考: プログラムからフォーカスを当てられるか（要素自身が focusable か）
    const programmaticallyFocusable = await page.evaluate((id) => {
      const el = document.getElementById(id);
      el.focus();
      return document.activeElement === el;
    }, target.id);

    // 支援技術に何として伝わるか。DOM の属性ではなく、ブラウザが計算した役割と名前を取る
    const aria = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return { tag: el.tagName.toLowerCase(), roleAttr: el.getAttribute('role'), tabindexAttr: el.getAttribute('tabindex') };
    }, target.id);
    let ariaSnapshot = null;
    try {
      ariaSnapshot = (await page.locator(`#${target.id}`).ariaSnapshot()).trim();
    } catch (error) {
      ariaSnapshot = `取得できず: ${error.message.split('\n')[0]}`;
    }

    // 操作ごとに新しいコンテキストで測る（history.length を独立に読むため）
    const measureOne = async (how) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      const result = await activate(p, base, target.id, how);
      await ctx.close();
      return result;
    };
    const byMouse = await measureOne('mouse');
    const byEnter = await measureOne('enter');
    const bySpace = await measureOne('space');

    records.push({
      engine: engineName,
      browserVersion: browser.version(),
      impl: target.label,
      id: target.id,
      ...aria,
      ariaSnapshot,
      tabStopsToReach: tabStops,
      tabTraversalMeasurable: tab.movedAtAll,
      tabSequenceObserved: tab.sequence,
      tabVerdict,
      programmaticallyFocusable,
      byMouse,
      byEnter,
      bySpace
    });

    const verdict = (r) => (r.navigated === null ? `測れない（${r.reason}）` : r.navigated ? '移動する' : '移動しない');
    console.log(`[${engineName}] ${target.label}`);
    console.log(`  Tab 走査の観測: ${tab.sequence.join(' → ')}`);
    console.log(`  Tab: ${tabVerdict} / focus() で当てられるか: ${programmaticallyFocusable ? 'できる' : 'できない'} / role・name: ${ariaSnapshot}`);
    console.log(`  マウス: ${verdict(byMouse)} / Enter: ${verdict(byEnter)} / Space: ${verdict(bySpace)}`);
    console.log(`  history.length: ${byMouse.historyBefore} → ${byMouse.historyAfter}（マウス操作時）`);
    await context.close();
  }

  await browser.close();
}

server.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-activation.mjs', root: ROOT, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
