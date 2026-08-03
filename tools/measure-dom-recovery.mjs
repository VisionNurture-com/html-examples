/**
 * measure-dom-recovery.mjs — 書いた HTML と、ブラウザが作った DOM の食い違いを測る
 *
 * 使い方:
 *   node tools/measure-dom-recovery.mjs
 *   node tools/measure-dom-recovery.mjs --engine chromium
 *   node tools/measure-dom-recovery.mjs --out tools/results/001-dom-recovery.json
 *
 * 測るもの: symptoms/001-unclosed/ の broken / fixed について、
 *   ① body 直下の要素の並び（書いた順と DOM の順が同じか）
 *   ② 閉じていない <a> が、後続のどこまでを取り込んだか（リンクの文字数）
 *   ③ <table> の直下に置いたテキストが DOM のどこに移されたか
 * を観測する。生ソースの行と DOM の位置を並べて、補正の結果を目に見える形にする。
 *
 * 「ブラウザはエラーを出さずに直す」という主張は、直した結果を観測しないと書けない。
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const TARGETS = [
  { name: 'broken', path: 'symptoms/001-unclosed/broken.html' },
  { name: 'fixed', path: 'symptoms/001-unclosed/fixed.html' },
];

function parseArgs(argv) {
  const opts = { engines: ['chromium', 'firefox', 'webkit'], out: 'tools/results/001-dom-recovery.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
  }
  for (const name of opts.engines) {
    if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (chromium | firefox | webkit)`);
  }
  return opts;
}

function probe() {
  const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // 補正の結果は「どの要素がどの中に入ったか」で表れるため、木構造ごと残す
  const tree = (el, depth = 0) => {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => trim(n.textContent))
      .filter(Boolean)
      .join('');
    const line = `${'  '.repeat(depth)}<${el.tagName.toLowerCase()}>${own ? ` "${own.slice(0, 30)}"` : ''}`;
    return [line, ...Array.from(el.children).flatMap((c) => tree(c, depth + 1))];
  };
  const a = document.querySelector('a');
  const table = document.querySelector('table');
  // table の直前にテキストだけのノード（または要素）が移されていないかを見る
  const beforeTable = table ? trim(table.previousSibling && table.previousSibling.textContent) : null;
  return {
    domTree: tree(document.body),
    bodyChildTags: Array.from(document.body.children).map((el) => el.tagName.toLowerCase()),
    anchor: a ? { text: trim(a.textContent), length: trim(a.textContent).length } : null,
    // 段落がリンクに飲み込まれると、a の外にある p の数が減る
    paragraphCount: document.querySelectorAll('p').length,
    paragraphsInsideAnchor: a ? a.querySelectorAll('p').length : 0,
    table: table
      ? {
          rowCount: table.querySelectorAll('tr').length,
          // 書いたときは table の内側にあったテキストが、DOM で外へ出ているか
          textMovedOutside: beforeTable,
          directTextInTable: trim(
            Array.from(table.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent)
              .join('')
          ),
        }
      : null,
  };
}

const opts = parseArgs(process.argv.slice(2));
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const version = browser.version();
  for (const target of TARGETS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`file://${resolve(target.path)}`);
    const observed = await page.evaluate(probe);
    const source = readFileSync(target.path, 'utf8');
    records.push({
      engine: engineName,
      engineVersion: version,
      target: target.name,
      path: target.path,
      sourceLines: source.split('\n').length,
      observed,
    });
    await context.close();
  }
  await browser.close();
}

const result = {
  measuredAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  note: '生ソースは読み込み前のファイル、observed は読み込み後の DOM。両者の差が補正の結果',
  records,
};

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

for (const r of records) {
  const o = r.observed;
  console.log(
    `${r.engine} ${r.engineVersion} / ${r.target}: body 直下=[${o.bodyChildTags.join(', ')}] a の文字数=${o.anchor ? o.anchor.length : '-'} a 内の p=${o.paragraphsInsideAnchor} 表の外へ出たテキスト="${o.table ? o.table.textMovedOutside : '-'}"`
  );
}
console.log(`written: ${opts.out}`);
