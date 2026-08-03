/**
 * measure-charset.mjs — 保存時のエンコーディングと <meta charset> の宣言が
 * 噛み合わないとき、日本語がどう表示されるかを測る
 *
 * 使い方:
 *   node tools/measure-charset.mjs
 *   node tools/measure-charset.mjs --engine chromium
 *   node tools/measure-charset.mjs --out tools/results/001-charset.json
 *   node tools/measure-charset.mjs --dir compare/001-charset-bom --out tools/results/001-charset-bom.json
 *   node tools/measure-charset.mjs --header-charset shift_jis --out tools/results/001-charset-header.json
 *
 * 測るもの: compare/001-charset-matrix/ の 6 通り（宣言 あり/なし × 保存 utf-8 / shift_jis / euc-jp）
 * について、①ブラウザが決めた文字コード（document.characterSet）②h1 の文字列が
 * 元の日本語と一致するか を観測する。
 *
 * 経路を 2 つ測る理由:
 *   file://  読者が手元でダブルクリックして開く経路。ヘッダがないので宣言と中身だけで決まる
 *   http://  配信する経路。本ハーネスのサーバは Content-Type に charset を付けずに返すため、
 *            ヘッダによる上書きが入らない状態で宣言の効き方を見られる
 * 1 経路だけ測って「こうなる」と書くと、もう一方で外れる。
 *
 * --header-charset を渡すと、既定で外している 3 つ目の変数（配信側が Content-Type に付ける
 * charset）を入れた状態を測る。ヘッダが宣言より優先されるかどうかを観測するための経路で、
 * file:// にはヘッダが存在しないため http:// のみを測る。既定では従来どおり付けない。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const DEFAULT_SAMPLE_DIR = 'compare/001-charset-matrix';
const EXPECTED_H1 = '日本語の見出し';
const PORT = 8101;

function parseArgs(argv) {
  const opts = {
    engines: ['chromium', 'firefox', 'webkit'],
    out: 'tools/results/001-charset.json',
    dir: DEFAULT_SAMPLE_DIR,
    headerCharset: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--dir') { opts.dir = argv[i + 1]; i += 1; }
    else if (argv[i] === '--header-charset') { opts.headerCharset = argv[i + 1]; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

/**
 * 既定では配信側は charset を付けない。付けるとヘッダが宣言より優先され、
 * 測りたい「宣言と保存の噛み合い」が見えなくなる。
 * headerCharset を渡したときだけ、その優先関係そのものを観測する経路になる。
 * 数える対象をパスで限定する（想定外のリクエストを 404 で弾く）。
 */
function startServer(files, sampleDir, headerCharset) {
  const contentType = headerCharset ? `text/html; charset=${headerCharset}` : 'text/html';
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const name = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0]);
      if (!files.includes(name)) { resp.writeHead(404); resp.end(); return; }
      const buf = readFileSync(join(sampleDir, name));
      resp.writeHead(200, { 'Content-Type': contentType });
      resp.end(buf);
    });
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}

function probe(expected) {
  const h1 = document.querySelector('h1');
  const text = h1 ? (h1.textContent || '') : '';
  return {
    characterSet: document.characterSet,
    h1Text: text,
    // 「読める」を目視でなく、元の文字列と一致するかで判定する
    readable: text === expected,
  };
}

const opts = parseArgs(process.argv.slice(2));
const files = readdirSync(opts.dir).filter((f) => f.endsWith('.html')).sort();
const server = await startServer(files, opts.dir, opts.headerCharset);
const records = [];
// ヘッダに charset を付けた状態は http でしか作れない。file:// にヘッダは存在しない。
const transports = opts.headerCharset ? ['http'] : ['file', 'http'];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const version = browser.version();
  for (const file of files) {
    const declared = file.startsWith('decl-yes') ? file.replace(/^decl-yes_save-(.+)\.html$/, '$1') : null;
    const saved = file.replace(/^decl-(yes|no)_save-(.+)\.html$/, '$2');
    for (const transport of transports) {
      const url = transport === 'file'
        ? `file://${resolve(join(opts.dir, file))}`
        : `http://127.0.0.1:${PORT}/${file}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const observed = await page.evaluate(probe, EXPECTED_H1);
      const record = { engine: engineName, engineVersion: version, file, declared, saved, transport, observed };
      if (opts.headerCharset) record.headerCharset = opts.headerCharset;
      records.push(record);
      await context.close();
    }
  }
  await browser.close();
}

server.close();

const result = {
  measuredAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  expectedH1: EXPECTED_H1,
  headerCharset: opts.headerCharset,
  note: opts.headerCharset
    ? `http 側は Content-Type: text/html; charset=${opts.headerCharset} で返す。宣言・保存とヘッダが食い違ったときにどれが勝つかを測る経路（file:// はヘッダが存在しないため測らない）`
    : 'http 側は Content-Type に charset を付けずに返す。付けるとヘッダが宣言より優先され、測りたい噛み合いが見えなくなる',
  records,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const r of records) {
  const o = r.observed;
  const header = r.headerCharset ? ` ヘッダ=${r.headerCharset}` : '';
  console.log(
    `${r.engine} ${r.engineVersion} / ${r.transport} / 宣言=${r.declared ?? 'なし'} 保存=${r.saved}${header} → characterSet=${o.characterSet} readable=${o.readable}`
  );
}
console.log(`written: ${opts.out}`);
