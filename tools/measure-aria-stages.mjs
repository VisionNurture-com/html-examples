/**
 * measure-aria-stages.mjs — div に role / tabindex / キー処理を段階的に足したとき、
 * どの段階で button に追いつくのかを測る
 *
 * 使い方:
 *   node tools/measure-aria-stages.mjs
 *   node tools/measure-aria-stages.mjs --engine firefox
 *   node tools/measure-aria-stages.mjs --out tools/results/005-aria-stages.json
 *
 * 測るもの: compare/005-aria-stages/index.html の 6 実装それぞれについて
 *   ① Tab キーだけで到達できるか（実際に Tab を押して document.activeElement を見る）
 *   ② プログラムからフォーカスを当てられるか（要素自身が focusable か）
 *   ③ マウスのクリックで起動するか
 *   ④ Enter キーで起動するか
 *   ⑤ Space キーで起動するか
 *   ⑥ 支援技術に伝わる役割と名前（Playwright が構築するアクセシビリティツリーの表現）
 *
 * 🔴 起動の判定は「ページの状態が変わったか」で行う（002 の遷移とは別の指標）。
 *   handler が呼ばれたかどうかを内部フラグで見ると、実際には押せていない操作を
 *   「押せた」と数えてしまう。表示テキストの変化という、読者が目で確かめられる事実で測る。
 *
 * 🔴 キーを押す前に、フォーカスが対象そのものに載っていることを必ず確かめる。
 *   確かめずに押すと、直前の操作で別の要素に載ったフォーカスを起動してしまい、
 *   存在しない差が出る（002 の measure-activation.mjs で実際に起きた誤読）。
 *
 * 🔴 差が出なかった操作も記録する。マウスは 6 実装すべてで動くはずで、
 *   その「差が出ないこと」自体が、この問題が見過ごされる理由である。結果から省かない。
 *
 * 🔴 ここで取れるのはツール側（アクセシビリティツリー）の表現であり、
 *   実機スクリーンリーダーが読み上げる文言とは別の層。混ぜて論じない。
 *   実機の逐語は tools/measure-voiceover.sh で別に取る。
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
const ROOT = 'compare/005-aria-stages';
const TARGETS = [
  { id: 's0', label: '段階 0：素の div' },
  { id: 's1', label: '段階 1：tabindex だけ' },
  { id: 's2', label: '段階 2：role だけ' },
  { id: 's3', label: '段階 3：role + tabindex' },
  { id: 's4', label: '段階 4：+ キー処理' },
  { id: 'native', label: '参照：button' }
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

/** Tab を押していき、対象 id に到達するまでの回数を返す。到達しなければ null。
 *  あわせて「Tab がそもそも何かに到達したか」と観測した並びも返す。
 *  🔴 Tab が 1 つも動かない環境では、「この要素に到達しない」ではなく
 *     「Tab 走査を測れない」と読む必要がある（002 の WebKit で実際に起きた）。
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
  return { stops, movedAtAll, sequence };
}

/** 指定の操作を行い、表示テキストが変わったか（＝起動したか）を返す */
async function activate(page, url, id, how) {
  await page.goto(url, { waitUntil: 'load' });
  const before = await page.evaluate(() => document.getElementById('status').textContent);

  if (how === 'mouse') {
    await page.click(`#${id}`);
  } else {
    const focusedOnTarget = await page.evaluate((target) => {
      document.activeElement?.blur?.();
      document.getElementById(target)?.focus();
      return document.activeElement?.id === target;
    }, id);
    if (!focusedOnTarget) {
      return { activated: null, reason: 'フォーカスを載せられないためキー操作を測れない', status: before };
    }
    await page.keyboard.press(how === 'enter' ? 'Enter' : 'Space');
  }

  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('status').textContent);
  return { activated: before !== after, status: after };
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
    const tabVerdict = tab.movedAtAll
      ? (tab.stops === null ? '到達しない' : `${tab.stops} 回目で到達`)
      : '測定不能（この環境では Tab がどの要素にも移らない）';

    const programmaticallyFocusable = await page.evaluate((id) => {
      const el = document.getElementById(id);
      el.focus();
      return document.activeElement === el;
    }, target.id);

    const attrs = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return {
        tag: el.tagName.toLowerCase(),
        roleAttr: el.getAttribute('role'),
        tabindexAttr: el.getAttribute('tabindex'),
        hasKeydown: el.hasAttribute('onkeydown')
      };
    }, target.id);

    let ariaSnapshot = null;
    try {
      ariaSnapshot = (await page.locator(`#${target.id}`).ariaSnapshot()).trim();
    } catch (error) {
      ariaSnapshot = `取得できず: ${error.message.split('\n')[0]}`;
    }

    // 🔴 ariaSnapshot（- text: / - button "…"）と computed role（generic / button）は別物。
    //   記事は「開発者ツールの Accessibility ペインに何と出るか」を載せるため、
    //   DevTools が表示するのと同じ computed role を CDP から取る。
    //   CDP は Chromium 専用なので、他エンジンは null にして未取得と分かる形で残す。
    let computedRole = null;
    let computedName = null;
    if (engineName === 'chromium') {
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Accessibility.enable');
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${target.id}` });
        const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
        const node = nodes.find((n) => n.backendDOMNodeId !== undefined) ?? nodes[0];
        computedRole = node?.role?.value ?? null;
        computedName = node?.name?.value ?? null;
        await cdp.detach();
      } catch (error) {
        computedRole = `取得できず: ${error.message.split('\n')[0]}`;
      }
    }

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
      id: target.id,
      label: target.label,
      ...attrs,
      tabStops: tab.stops,
      tabVerdict,
      tabSequence: tab.sequence,
      programmaticallyFocusable,
      ariaSnapshot,
      computedRole,
      computedName,
      activatedByMouse: byMouse.activated,
      activatedByEnter: byEnter.activated,
      activatedBySpace: bySpace.activated,
      enterNote: byEnter.reason ?? null,
      spaceNote: bySpace.reason ?? null
    });

    await context.close();
  }

  await browser.close();
}

server.close();

const table = records.map((r) => ({
  engine: r.engine,
  実装: r.label,
  Tab: r.tabVerdict,
  focus可: r.programmaticallyFocusable ? 'はい' : 'いいえ',
  マウス: r.activatedByMouse === null ? '—' : (r.activatedByMouse ? '起動する' : '起動しない'),
  Enter: r.activatedByEnter === null ? '測れない' : (r.activatedByEnter ? '起動する' : '起動しない'),
  Space: r.activatedBySpace === null ? '測れない' : (r.activatedBySpace ? '起動する' : '起動しない'),
  ツリーの表現: (r.ariaSnapshot ?? '').replace(/\s+/g, ' ').slice(0, 40),
  'DevTools の Role': r.computedRole ?? '—（CDP 非対応）'
}));
console.table(table);

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify({ measuredAt: new Date().toISOString(), records }, null, 2));
  console.log(`\n生データ: ${opts.out}`);
}
