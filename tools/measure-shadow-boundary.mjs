/**
 * measure-shadow-boundary.mjs — Web Components の 3 症状が「本当に起きるか」を測る
 *
 * 使い方:
 *   node tools/measure-shadow-boundary.mjs
 *   node tools/measure-shadow-boundary.mjs --engine chromium
 *   node tools/measure-shadow-boundary.mjs --out tools/results/008-shadow-boundary.json
 *
 * 測るもの: symptoms/008-* の broken / fixed それぞれについて
 *   ① 外側の CSS が Shadow DOM の中の要素に届いたか（getComputedStyle の実測値）
 *   ② slot に渡した中身が実際に投影されたか（assignedNodes の実測）
 *   ③ connectedCallback の時点で子要素が見えたか（data-counted の実測値）
 *
 * 🔴 「当たっているはず」を静的に判定しない。
 *   クラス名やセレクタの一致で判定すると「そう書いてあるか」を測ることになる。
 *   ここでは描画後の getComputedStyle と assignedNodes を読む。
 *
 * 🔴 1 エンジンの結果を実装一般の話にしない。
 *   結果には engine と version を必ず添える。
 *
 * ⚠️ 本ハーネスは file:// ではなくローカル HTTP で開く。
 *   Shadow DOM 自体は file:// でも動くが、他ハーネスと観測条件を揃えるため統一する。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };

const TARGETS = [
  {
    id: 'shadow-css',
    label: '外側の CSS が中に届くか',
    files: {
      broken: 'symptoms/008-shadow-css-not-applied/broken.html',
      fixed: 'symptoms/008-shadow-css-not-applied/fixed.html',
    },
    probe: () => {
      const host = document.getElementById('target');
      const root = host.shadowRoot;
      const label = root.querySelector('.label');
      const frame = root.querySelector('.frame');
      const outside = document.querySelector('p.label');
      return {
        shadowLabelColor: getComputedStyle(label).color,
        shadowFrameBorderWidth: getComputedStyle(frame).borderTopWidth,
        outsideLabelColor: getComputedStyle(outside).color,
        shadowRootMode: root.mode,
      };
    },
  },
  {
    id: 'slot',
    label: 'slot に渡した中身が投影されるか',
    files: {
      broken: 'symptoms/008-slot-not-shown/broken.html',
      fixed: 'symptoms/008-slot-not-shown/fixed.html',
    },
    probe: () => {
      const host = document.getElementById('target');
      const root = host.shadowRoot;
      const named = root.querySelector('slot[name]');
      const dflt = root.querySelector('slot:not([name])');
      const names = (slot) =>
        slot ? slot.assignedNodes({ flatten: false })
          .filter((n) => n.nodeType === 1)
          .map((n) => n.tagName.toLowerCase()) : [];
      const heading = host.querySelector('h2');
      return {
        namedSlotName: named ? named.getAttribute('name') : null,
        headingSlotAttr: heading ? heading.getAttribute('slot') : null,
        assignedToNamed: names(named),
        assignedToDefault: names(dflt),
        // 投影されなかった要素は描画されない。実際の見た目で確かめる
        headingRenderedHeight: heading ? heading.getBoundingClientRect().height : null,
      };
    },
  },
  {
    id: 'connected-callback',
    label: 'connectedCallback の時点で子要素が見えるか',
    files: {
      broken: 'symptoms/008-connected-callback-empty/broken.html',
      fixed: 'symptoms/008-connected-callback-empty/fixed.html',
    },
    probe: () => {
      const host = document.getElementById('target');
      return {
        countedAtConnected: host.dataset.counted ?? null,
        actualChildLi: host.querySelectorAll('li').length,
        outputText: document.getElementById('out').textContent,
      };
    },
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const file = join(rootDir, rel);
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function parseArgs(argv) {
  const out = { engines: Object.keys(ENGINES), out: 'tools/results/008-shadow-boundary.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') out.engines = [argv[i + 1]];
    if (argv[i] === '--out') out.out = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const { server, port } = await startServer(process.cwd());
const results = { measuredAt: new Date().toISOString(), engines: {} };

for (const name of args.engines) {
  const browser = await ENGINES[name].launch();
  const version = browser.version();
  const page = await browser.newPage();
  const perEngine = { version, targets: {} };

  for (const t of TARGETS) {
    perEngine.targets[t.id] = { label: t.label, variants: {} };
    for (const [variant, file] of Object.entries(t.files)) {
      await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'load' });
      // カスタム要素の昇格を待つ。定義名はファイルごとに違うため whenDefined は使わず
      // shadowRoot / dataset の出現を条件にする（「待てたか」を戻り値で残す）
      let settled = true;
      try {
        await page.waitForFunction(() => {
          const host = document.getElementById('target');
          return Boolean(host && (host.shadowRoot || host.dataset.counted !== undefined));
        }, null, { timeout: 3000 });
      } catch {
        settled = false;
      }
      const observed = await page.evaluate(t.probe);
      perEngine.targets[t.id].variants[variant] = { file, upgradeSettled: settled, ...observed };
    }
  }

  results.engines[name] = perEngine;
  await browser.close();
}

server.close();

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${args.out}`);
for (const [engine, data] of Object.entries(results.engines)) {
  console.log(`\n[${engine} ${data.version}]`);
  for (const [id, t] of Object.entries(data.targets)) {
    console.log(`  ${id} — ${t.label}`);
    for (const [variant, v] of Object.entries(t.variants)) {
      const { file, ...rest } = v;
      console.log(`    ${variant}: ${JSON.stringify(rest)}`);
    }
  }
}
