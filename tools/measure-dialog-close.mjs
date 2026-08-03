/**
 * measure-dialog-close.mjs — 開閉部品が「何を肩代わりし、何を肩代わりしないか」を測る
 *
 * 使い方:
 *   node tools/measure-dialog-close.mjs
 *   node tools/measure-dialog-close.mjs --engine chromium
 *   node tools/measure-dialog-close.mjs --out tools/results/004-close-control.json
 *
 * 測るもの: compare/004-close-control/ の 5 実装それぞれについて
 *   ① 開いた直後にフォーカスがどこにあるか
 *   ② Tab を押し続けたとき、フォーカスがモーダルの外（背面）へ出るか
 *   ③ Esc で閉じるか
 *   ④ 外側のクリックで閉じるか
 *   ⑤ 閉じるボタンで閉じたあと、フォーカスがどこへ戻るか
 *   ⑥ 開いている間に背面がスクロールするか
 *   ⑦ closedby 属性がそのエンジンで解釈されるか（feature detection）
 *
 * 🔴 到達可否を静的セレクタで数えない。
 *   `button, a[href]` のようなセレクタで数えると「その定義に当てはまるか」を測ることになる。
 *   ここでは実際に Tab を押して document.activeElement を読む。
 *
 * 🔴 キーが届いたかを先に確かめる。
 *   Tab を押す前に「フォーカスがモーダルの中にあるか」を記録し、
 *   出発点が想定どおりでない測定結果は tabStartInsideDialog=false として残す。
 *
 * 🔴 自動の Tab 走査は「そのエンジンの話」であり実機一般の代理にならない。
 *   本ハーネスの結果に engine と version を必ず添える。実機の走査は別途 AppleScript で測る。
 *
 * ⚠️ Playwright の Tab はページ内で完結する。ブラウザ UI へ抜けるかは本ハーネスでは測れない。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'compare/004-close-control';
const TARGETS = [
  { file: 'a-custom.html', label: '自作 div', kind: 'custom' },
  { file: 'b-dialog.html', label: 'dialog（showModal 既定）', kind: 'dialog' },
  { file: 'c-closedby-any.html', label: 'dialog closedby=any', kind: 'dialog' },
  { file: 'd-details.html', label: 'details', kind: 'details' },
  { file: 'e-popover.html', label: 'popover', kind: 'popover' }
];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const TAB_LIMIT = 8;

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  return opts;
}

// Lighthouse が file:// を拒否するため、
// 全手段を同じ HTTP URL に対して測れるよう最小サーバを内蔵する。
function startServer() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0]));
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// 実装ごとに「開いているか」の判定式が違う。判定式そのものを結果に残す（何を測ったかを後から検算できるように）
const OPEN_EXPR = {
  custom: () => document.getElementById('box').hasAttribute('data-open'),
  dialog: () => document.getElementById('box').open === true,
  details: () => document.getElementById('box').open === true,
  popover: () => { try { return document.getElementById('box').matches(':popover-open'); } catch { return null; } }
};

const activeId = () => (document.activeElement ? (document.activeElement.id || document.activeElement.tagName.toLowerCase()) : null);

async function measureOne(page, url, target) {
  const isOpen = OPEN_EXPR[target.kind];
  const out = { file: target.file, label: target.label, kind: target.kind };

  await page.goto(url);
  out.closedbySupported = await page.evaluate(() => {
    try { return 'closedBy' in HTMLDialogElement.prototype; } catch { return null; }
  });

  // ① 開いた直後のフォーカス
  await page.click('#open');
  out.openedOk = await page.evaluate(isOpen);
  out.focusAfterOpen = await page.evaluate(activeId);
  out.tabStartInsideDialog = await page.evaluate(
    () => !!document.getElementById('box')?.contains(document.activeElement)
  );

  // ② Tab 走査（実際に押して activeElement を読む）
  // 🔴 素の Tab で動かなければ Option(Alt)+Tab で測り直す（2026-08-02 追加）。
  //   WebKit は Safari と同じく素の Tab がフォームコントロールしか巡回しない。
  //   実機ハーネス measure-dialog-real-browser.mjs は同じフォールバックを持っていたが、
  //   自動測定側だけが持たず、自作 div と popover の到達可否が「未測定（null）」で残っていた。
  const runTabs = async (key) => {
    const seq = [];
    for (let i = 0; i < TAB_LIMIT; i += 1) {
      await page.keyboard.press(key);
      seq.push(await page.evaluate(activeId));
    }
    return seq;
  };
  const tabMovedIn = (seq) => new Set(seq.filter((x) => x && x !== 'body')).size >= 1;
  const order = await runTabs('Tab');
  out.tabOrder = order;
  out.tabMethod = 'Tab';
  // 🔴 積極確認: Tab がそもそも動いたか。動いていない環境の結果を「抜けなかった」と読まない
  out.tabMoved = tabMovedIn(order);
  if (!out.tabMoved) {
    // 開き直してから手法を変える（空振りした状態を引きずらない）
    await page.goto(url);
    await page.click('#open');
    const alt = await runTabs('Alt+Tab');
    if (tabMovedIn(alt)) {
      out.tabOrderPlain = order;
      out.tabOrder = alt;
      out.tabMoved = true;
      out.tabMethod = 'Option+Tab';
    }
  }
  out.tabReachedBackground = out.tabMoved
    ? (out.tabOrder.includes('after') || out.tabOrder.includes('open'))
    : null;

  // ⑥ 背面がスクロールするか（開いたまま測る）
  out.scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  out.scrollAfterWheel = await page.evaluate(() => window.scrollY);
  out.backgroundScrolls = out.scrollAfterWheel > out.scrollBeforeWheel;
  await page.evaluate(() => window.scrollTo(0, 0));

  // ③ Esc
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  out.escCloses = (await page.evaluate(isOpen)) === false;

  // ④ 外側クリック（再度開いてから）
  await page.goto(url);
  await page.click('#open');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  out.outsideClickCloses = (await page.evaluate(isOpen)) === false;

  // ⑤-a 閉じるボタンをマウスでクリック → 復帰位置
  await page.goto(url);
  await page.click('#open');
  out.focusBeforeCloseMouse = await page.evaluate(activeId);
  await page.click('#ng');
  await page.waitForTimeout(150);
  out.buttonCloses = (await page.evaluate(isOpen)) === false;
  out.focusAfterCloseMouse = await page.evaluate(activeId);

  // ⑤-b キーボードで開いて閉じる → 復帰位置
  // 🔴 マウスのクリックでフォーカスを与えないエンジンがある（macOS の WebKit）。
  //   起点が測れていない状態の結果を「復帰しない」と読まないため、起点を固定した経路も測る。
  await page.goto(url);
  await page.focus('#open');
  out.openerFocusedBeforeOpen = (await page.evaluate(activeId)) === 'open';
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  out.openedByKeyboard = await page.evaluate(isOpen);
  await page.focus('#ng');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  out.closedByKeyboard = (await page.evaluate(isOpen)) === false;
  out.focusAfterCloseKeyboard = await page.evaluate(activeId);
  // 起点が固定できた場合にのみ「復帰したか」を判定する。できていなければ null（未測定）
  out.focusReturnedToOpener = out.openerFocusedBeforeOpen && out.openedByKeyboard
    ? out.focusAfterCloseKeyboard === 'open'
    : null;

  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { server, port } = await startServer();
  const results = { measuredAt: new Date().toISOString(), root: ROOT, tabLimit: TAB_LIMIT, engines: {} };

  for (const name of opts.engines) {
    const browser = await ENGINES[name].launch();
    const entry = { version: browser.version(), targets: [] };
    const page = await browser.newPage();
    for (const t of TARGETS) {
      entry.targets.push(await measureOne(page, `http://127.0.0.1:${port}/${t.file}`, t));
    }
    await browser.close();
    results.engines[name] = entry;
    console.log(`[${name} ${entry.version}]`);
    for (const r of entry.targets) {
      const tab = r.tabMoved ? String(r.tabReachedBackground) : 'Tab不動(未測定)';
      const back = r.focusReturnedToOpener === null ? '起点不成立(未測定)' : `${r.focusReturnedToOpener}(${r.focusAfterCloseKeyboard})`;
      console.log(`  ${r.label.padEnd(26)} open=${r.openedOk} tab外へ=${tab} Esc=${r.escCloses} 外側=${r.outsideClickCloses} 背面scroll=${r.backgroundScrolls} 復帰=${back} closedby=${r.closedbySupported}`);
    }
  }

  server.close();
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${opts.out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
