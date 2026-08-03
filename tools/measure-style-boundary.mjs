/**
 * measure-style-boundary.mjs — Shadow DOM の境界を「何が越えて何が越えないか」で測る
 *
 * 使い方:
 *   node tools/measure-style-boundary.mjs
 *   node tools/measure-style-boundary.mjs --engine chromium
 *   node tools/measure-style-boundary.mjs --out tools/results/008-style-boundary.json
 *
 * 測るもの: compare/008-style-boundary/ の 7 実装それぞれで、同一のページ側 CSS が
 *   ① 継承するプロパティ（color / font-family）として中へ届くか
 *   ② クラスセレクタ（.label）の指定として中へ届くか
 *   ③ CSS カスタムプロパティ（--card-accent）として中へ届くか
 *   ④ ::part(title) の指定として中へ届くか
 *   ⑤ 外から document.querySelector('#probe') で中の要素に届くか（DOM 側の境界）
 *   ⑥ :host（部品が自分に当てる指定）とページ側の要素セレクタのどちらが勝つか
 *
 * 🔴 7 ファイルのページ側 <style> は共通行を同一にしてある。
 *   違うのは部品側の作り（Shadow を張るか / part を付けるか / 変数を読むか / :host を書くか）だけ。
 *   同じ入力に対して出力がどう変わるかを測る設計にしている。
 *
 * ⚠️ ⑥ の hostOutline* が意味を持つのは f-host-rule.html だけ。
 *   他の 6 ファイルはページ側に outline 指定がなく、初期値（medium / currentColor）が出る。
 *
 * 🔴 「届いたはず」をセレクタの一致で判定しない。
 *   描画後の getComputedStyle の実測値を読む。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'compare/008-style-boundary';
const TARGETS = [
  { file: 'a-no-shadow.html', label: '境界なし（Shadow を張らない）' },
  { file: 'b-shadow-plain.html', label: '境界あり（受け取り口なし）' },
  { file: 'c-custom-property.html', label: '境界あり（変数で受け取る）' },
  { file: 'd-part.html', label: '境界あり（part を公開）' },
  { file: 'e-mode-closed.html', label: '境界あり（mode: closed・部品が自己申告）' },
  { file: 'f-host-rule.html', label: '境界あり（:host とページ側の my-card がぶつかる）' },
  { file: 'g-external-link.html', label: '境界あり（Shadow の中で外部 CSS を link）' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const file = join(rootDir, rel);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = { engines: Object.keys(ENGINES), out: 'tools/results/008-style-boundary.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') out.engines = [argv[i + 1]];
    if (argv[i] === '--out') out.out = argv[i + 1];
  }
  return out;
}

const probe = () => {
  const host = document.getElementById('target');
  const root = host.shadowRoot;

  // mode: closed は外から中を取れない。部品が自己申告した値を読む
  if (!root && host.dataset.observed) {
    return {
      hasShadowRoot: false,
      probeFoundIn: 'closedShadowRoot（部品の自己申告）',
      selfReported: true,
      reachableFromDocument: Boolean(document.querySelector('#probe')),
      hostOutlineColor: getComputedStyle(host).outlineColor,
      hostOutlineWidth: getComputedStyle(host).outlineWidth,
      ...JSON.parse(host.dataset.observed),
    };
  }

  // 境界の有無で probe の在処が変わる。まず「どこにいるか」を記録する
  const el = root ? root.getElementById('probe') : host.querySelector('#probe');
  const cs = getComputedStyle(el);
  return {
    hasShadowRoot: Boolean(root),
    probeFoundIn: root ? 'shadowRoot' : 'lightDOM',
    // ① 継承するプロパティ
    color: cs.color,
    fontFamily: cs.fontFamily,
    // ② クラスセレクタ / ③ 変数 / ④ ::part — いずれも border-bottom に集約して観測
    borderBottomWidth: cs.borderBottomWidth,
    borderBottomColor: cs.borderBottomColor,
    // ④ ::part は text-decoration で観測（他と混ざらないプロパティを割り当てた）
    textDecorationLine: cs.textDecorationLine,
    // ⑤ DOM 側の境界
    reachableFromDocument: Boolean(document.querySelector('#probe')),
    // 変数そのものが中まで見えているか（③ の内訳）
    customPropertyVisible: cs.getPropertyValue('--card-accent').trim(),
    // ⑥ :host（部品が自分に当てる指定）とページ側の要素セレクタのどちらが勝つか
    hostOutlineColor: getComputedStyle(host).outlineColor,
    hostOutlineWidth: getComputedStyle(host).outlineWidth,
  };
};

const args = parseArgs(process.argv.slice(2));
const { server, port } = await startServer(process.cwd());
const results = { measuredAt: new Date().toISOString(), engines: {} };

for (const name of args.engines) {
  const browser = await ENGINES[name].launch();
  const version = browser.version();
  const page = await browser.newPage();
  const per = { version, targets: {} };

  for (const t of TARGETS) {
    await page.goto(`http://127.0.0.1:${port}/${ROOT}/${t.file}`, { waitUntil: 'load' });
    let settled = true;
    try {
      await page.waitForFunction(
        () => document.getElementById('target')?.dataset.ready === '1', null, { timeout: 3000 });
    } catch { settled = false; }
    per.targets[t.file] = { label: t.label, upgradeSettled: settled, ...(await page.evaluate(probe)) };
  }

  results.engines[name] = per;
  await browser.close();
}

server.close();
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${args.out}`);

for (const [engine, d] of Object.entries(results.engines)) {
  console.log(`\n[${engine} ${d.version}]`);
  for (const [file, v] of Object.entries(d.targets)) {
    console.log(`  ${file} — ${v.label}`);
    console.log(`    継承(color)      : ${v.color}`);
    console.log(`    継承(font)       : ${v.fontFamily}`);
    console.log(`    クラス/変数(border): ${v.borderBottomWidth} ${v.borderBottomColor}`);
    console.log(`    ::part(text-deco): ${v.textDecorationLine}`);
    console.log(`    変数の可視        : "${v.customPropertyVisible}"`);
    console.log(`    document から到達 : ${v.reachableFromDocument}`);
    console.log(`    host の outline    : ${v.hostOutlineWidth} ${v.hostOutlineColor}`);
  }
}
