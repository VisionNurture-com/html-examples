/**
 * measure-html-cache.mjs — 「更新したのに古いまま」が、どの条件で起きるかを測る
 *
 * 使い方:
 *   node tools/measure-html-cache.mjs
 *   node tools/measure-html-cache.mjs --engine chromium
 *   node tools/measure-html-cache.mjs --out tools/results/001-cache.json
 *
 * 測るもの: HTML 本体を 3 通りのキャッシュ指示で配信し、
 *   ① 初回表示 ② 再読み込み ③ 中身を書き換えた後の再読み込み
 * の各時点で **サーバに何回届いたか** と **画面に出ている版** を観測する。
 *
 * 🔴 数え方の規律: 「再取得されたか」を transferSize = 0 で判定しない。
 * サーバ側の到達回数で数える。あわせて **数える対象をパスで限定**する
 * （003 で /favicon.ico を混ぜて、存在しないブラウザ差を作った）。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const PORT = 8102;
const PATHNAME = '/page.html';

// 配信するキャッシュ指示の 3 通り
const MODES = [
  { name: 'no-store', header: 'no-store', note: '毎回取りに来ることを期待する指示' },
  { name: 'max-age=600', header: 'max-age=600', note: '10 分は再利用してよいという指示' },
  { name: '指示なし', header: null, note: 'Cache-Control を返さない。ブラウザの判断に委ねる' },
];

function parseArgs(argv) {
  const opts = { engines: ['chromium', 'firefox', 'webkit'], out: 'tools/results/001-cache.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

const state = { version: 'v1', header: null, hits: 0, otherPaths: [] };

function page(version) {
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>キャッシュの確認</title>
  </head>
  <body>
    <h1 id="version">${version}</h1>
  </body>
</html>
`;
}

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const url = (req.url || '').split('?')[0];
      // 数える対象をパスで限定する。favicon 等が混ざると差が捏造される
      if (url !== PATHNAME) {
        state.otherPaths.push(url);
        resp.writeHead(404);
        resp.end();
        return;
      }
      state.hits += 1;
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (state.header) headers['Cache-Control'] = state.header;
      resp.writeHead(200, headers);
      resp.end(page(state.version));
    });
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}

const opts = parseArgs(process.argv.slice(2));
const server = await startServer();
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const version = browser.version();
  for (const mode of MODES) {
    const context = await browser.newContext();
    const p = await context.newPage();

    state.header = mode.header;
    state.version = 'v1';
    state.hits = 0;

    await p.goto(`http://127.0.0.1:${PORT}${PATHNAME}`);
    const shownFirst = await p.textContent('#version');
    const hitsAfterFirst = state.hits;

    await p.reload();
    const shownReload = await p.textContent('#version');
    const hitsAfterReload = state.hits;

    // ここで「ファイルを編集した」状況を作る
    state.version = 'v2';
    await p.reload();
    const shownAfterEdit = await p.textContent('#version');
    const hitsAfterEdit = state.hits;

    // 「リロードではなく、別ページから戻ってきた」経路も測る。
    // リロードは仕様上キャッシュを検証しにいくため、これだけでは読者の体験を再現できない。
    state.version = 'v3';
    await p.goto('about:blank');
    await p.goto(`http://127.0.0.1:${PORT}${PATHNAME}`);
    const shownAfterRevisit = await p.textContent('#version');
    const hitsAfterRevisit = state.hits;

    records.push({
      engine: engineName,
      engineVersion: version,
      mode: mode.name,
      cacheControl: mode.header,
      note: mode.note,
      serverHits: { afterFirst: hitsAfterFirst, afterReload: hitsAfterReload, afterEdit: hitsAfterEdit, afterRevisit: hitsAfterRevisit },
      shown: { first: shownFirst, reload: shownReload, afterEdit: shownAfterEdit, afterRevisit: shownAfterRevisit },
      // 編集後の再読み込みで新しい版が出たか（読者が体験する「反映されたか」）
      reflectedAfterEdit: shownAfterEdit === 'v2',
      // リンクで再訪したときに新しい版が出たか
      reflectedAfterRevisit: shownAfterRevisit === 'v3',
    });
    await context.close();
  }
  await browser.close();
}

server.close();

const result = {
  measuredAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  countedPath: PATHNAME,
  note: '再取得の判定は transferSize でなくサーバ到達回数。対象は countedPath のみを数える',
  otherPathsRequested: Array.from(new Set(state.otherPaths)),
  records,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const r of records) {
  const h = r.serverHits;
  console.log(
    `${r.engine} ${r.engineVersion} / ${r.mode}: 到達=${h.afterFirst}/${h.afterReload}/${h.afterEdit}/${h.afterRevisit} 画面=${r.shown.first}→${r.shown.reload}→${r.shown.afterEdit}→${r.shown.afterRevisit} リロード反映=${r.reflectedAfterEdit} 再訪反映=${r.reflectedAfterRevisit}`
  );
}
console.log(`countedPath 以外へのリクエスト: ${JSON.stringify(result.otherPathsRequested)}`);
console.log(`written: ${opts.out}`);
