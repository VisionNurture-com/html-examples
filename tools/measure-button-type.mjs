/**
 * measure-button-type.mjs — button の type を書かなかったときに、ブラウザが何として扱うかを測る
 *
 * 使い方:
 *   node tools/measure-button-type.mjs
 *   node tools/measure-button-type.mjs --engine webkit
 *   node tools/measure-button-type.mjs --out tools/results/002-button-type.json
 *
 * 測るもの: symptoms/002-no-action/button-in-form.html の 2 つのボタンについて
 *   ① 属性として書いた type（書いていなければ null）
 *   ② ブラウザが解決した type（DOM プロパティ）
 *   ③ 押したときにフォームの送信が起きたか（URL の変化とクエリ文字列で判定する）
 *
 * 🔴 「押しても何も起きない」の裏返しを分けて記録する。
 *   type を書かない button はフォームの中では送信ボタンになる。押した瞬間にページが移動するため、
 *   読者からは「勝手に再読み込みされた」と見える。移動の有無だけでなく、解決された type と
 *   送信先の URL（クエリが付いたか）を分けて残し、原因を type に帰属できる形にする。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const ROOT = 'symptoms/002-no-action';
const FILE = 'button-in-form.html';
const CASES = [
  { id: 'implicit', label: 'type を書いていない button（フォームの中）' },
  { id: 'explicit', label: 'type="button" を書いた button（フォームの中）' }
];

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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const opts = parseArgs(process.argv.slice(2));
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  for (const c of CASES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(base + FILE, { waitUntil: 'load' });

    const before = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return {
        tag: el.tagName.toLowerCase(),
        typeAttr: el.getAttribute('type'),
        typeResolved: el.type,
        formAction: el.form ? el.form.getAttribute('action') : null,
        insideForm: Boolean(el.form)
      };
    }, c.id);

    const urlBefore = page.url();
    await page.click(`#${c.id}`);
    await page.waitForTimeout(500);
    const urlAfter = page.url();

    const record = {
      engine: engineName,
      browserVersion: browser.version(),
      file: FILE,
      id: c.id,
      label: c.label,
      ...before,
      navigated: urlBefore !== urlAfter,
      urlAfter: urlAfter.replace(base, '/'),
      // クエリ文字列が付いていれば、移動ではなく「フォームが送信された」と判定できる
      querySubmitted: new URL(urlAfter).search
    };
    records.push(record);
    console.log(`[${engineName}] ${c.label}`);
    console.log(`  type 属性: ${JSON.stringify(before.typeAttr)} / ブラウザが解決した type: ${before.typeResolved}`);
    console.log(`  押した後: ${record.navigated ? '移動した' : '移動しない'} → ${record.urlAfter}${record.querySubmitted ? `（送信のクエリ: ${record.querySubmitted}）` : ''}`);
    await context.close();
  }
  await browser.close();
}

server.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ tool: 'tools/measure-button-type.mjs', root: ROOT, records }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
