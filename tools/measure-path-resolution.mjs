/**
 * measure-path-resolution.mjs — 「別のファイルを見ている」状態を、観測できる形にする
 *
 * 使い方:
 *   node tools/measure-path-resolution.mjs                       # 001（既定）
 *   node tools/measure-path-resolution.mjs --engine chromium
 *   node tools/measure-path-resolution.mjs --preset 002-path     # 002（a href の書き分け）
 *   node tools/measure-path-resolution.mjs --out tools/results/001-path.json
 *
 * 測るもの: 対象ディレクトリの各リンクを辿り、
 *   ① 解決された URL ② HTTP ステータス ③ 実際に開いたページのタイトル
 * を観測する。リンクの書き方と実ファイルの場所が食い違うと何が起きるかを、
 * 「表示されない」ではなく **Status と URL** で示せるようにする。
 *
 * 🔴 数える対象をパスで限定する。favicon 等の付随リクエストは 404 で弾き、
 * 記録には残すが判定には混ぜない。
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
// 2026-07-29: 002（a href のパス解決）でも測れるようパラメータ化した。
// 既定値は 001 のときのまま。引数なしで実行すれば 001 と同じ測定になる。
const PRESETS = {
  '001-save-target': {
    root: 'symptoms/001-save-target',
    out: 'tools/results/001-path.json',
    expectTitle: '使い方',
    links: [
      { id: 'wrong', note: '同じ階層にあると思って書いたリンク' },
      { id: 'right', note: '実ファイルの場所に合わせたリンク' },
    ],
  },
  '002-path': {
    root: 'symptoms/002-path',
    out: 'tools/results/002-path.json',
    expectTitle: '10 月のお知らせ',
    links: [
      { id: 'relative', note: 'このページから見た位置で書いたリンク（相対）' },
      { id: 'root-relative', note: 'サイトの先頭から見た位置で書いたリンク（ルート相対）' },
      { id: 'wrong', note: '階層を数え間違えたリンク' },
      { id: 'blank', note: '別タブで開く指定を付けたリンク' },
    ],
  },
};

const PORT = 8103;

function parseArgs(argv) {
  const opts = { engines: ['chromium', 'firefox', 'webkit'], preset: '001-save-target', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--preset') { opts.preset = argv[i + 1]; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  if (!PRESETS[opts.preset]) throw new Error(`unknown preset: ${opts.preset} (${Object.keys(PRESETS).join(' | ')})`);
  opts.out = opts.out ?? PRESETS[opts.preset].out;
  return opts;
}

const otherPaths = [];

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
      const file = join(ROOT, rel);
      if (!existsSync(file)) {
        otherPaths.push(url);
        resp.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        resp.end('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>404</title></head><body><h1>404</h1></body></html>');
        return;
      }
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      resp.end(readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}

const opts = parseArgs(process.argv.slice(2));
const { root: ROOT, links: LINKS, expectTitle: EXPECT_TITLE } = PRESETS[opts.preset];
const server = await startServer();
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const version = browser.version();
  for (const link of LINKS) {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/index.html`);
    const href = await p.getAttribute(`#${link.id}`, 'href');
    const target = await p.getAttribute(`#${link.id}`, 'target');

    // target="_blank" は同じページが遷移しないため、新しく開いたページ側で観測する
    let opened = p;
    let response = null;
    let openedInNewTab = false;
    if (target === '_blank') {
      const [newPage] = await Promise.all([context.waitForEvent('page'), p.click(`#${link.id}`)]);
      await newPage.waitForLoadState();
      opened = newPage;
      openedInNewTab = true;
      response = null; // 新規タブの初回応答はここでは取らない（URL と title で判定する）
    } else {
      [response] = await Promise.all([p.waitForNavigation(), p.click(`#${link.id}`)]);
    }

    records.push({
      engine: engineName,
      engineVersion: version,
      link: link.id,
      note: link.note,
      writtenHref: href,
      targetAttr: target,
      openedInNewTab,
      // 別タブで開いた場合、元のページは遷移していない（読者には「飛んでいない」ように見える）
      originalPageUrl: p.url().replace(`http://127.0.0.1:${PORT}`, ''),
      resolvedUrl: opened.url().replace(`http://127.0.0.1:${PORT}`, ''),
      status: response ? response.status() : null,
      title: await opened.title(),
      // 読者が「開けた」と思えるかどうか
      reached: (await opened.title()) === EXPECT_TITLE,
    });
    await context.close();
  }
  await browser.close();
}

server.close();

const result = {
  measuredAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  root: ROOT,
  note: '判定は「表示されたか」ではなく Status と解決された URL。付随リクエストは判定に混ぜない',
  otherPathsRequested: Array.from(new Set(otherPaths)),
  records,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const r of records) {
  console.log(
    `${r.engine} ${r.engineVersion} / ${r.link}: 書いた href="${r.writtenHref}" → 解決先=${r.resolvedUrl} Status=${r.status} title="${r.title}" 到達=${r.reached}`
  );
}
console.log(`判定に混ぜなかったリクエスト: ${JSON.stringify(result.otherPathsRequested)}`);
console.log(`written: ${opts.out}`);
