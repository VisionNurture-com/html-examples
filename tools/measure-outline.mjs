/**
 * measure-outline.mjs — 見出しの並び・ランドマーク・表の構造が、
 * 支援技術から見てどう組み立てられているかを測る
 *
 * 使い方:
 *   node tools/measure-outline.mjs symptoms/005-heading-order/*.html
 *   node tools/measure-outline.mjs --engine webkit symptoms/005-table-semantics/*.html
 *   node tools/measure-outline.mjs --out tools/results/005-outline.json <files...>
 *
 * 測るもの（ファイルごと・エンジンごと）:
 *   ① 見出しの並び（レベルと文言。段が飛んでいる箇所を検出する）
 *   ② ランドマークの数（main が 1 つに定まっているか）
 *   ③ 表の構造（caption の有無 / th の数 / scope の付与状況）
 *   ④ ページ全体のアクセシビリティツリー（ariaSnapshot）
 *
 * 🔴 「段が飛んでいる」の判定は DOM のタグ名ではなくブラウザが計算した見出しレベルで行う。
 *   role="heading" aria-level="..." で作られた見出しはタグ名から読めないため。
 *
 * 🔴 ここで取れるのはツール側の表現であり、実機スクリーンリーダーの読み上げとは別の層。
 *   実機の逐語は tools/measure-voiceover.applescript で別に取る。混ぜて論じない。
 *
 * エンジンは chromium / firefox / webkit の 3 つを既定で測る。
 *
 * 依存: playwright（devDependencies）
 */

import { chromium, firefox, webkit } from 'playwright';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINES = { chromium, firefox, webkit };

function parseArgs(argv) {
  const opts = { engines: Object.keys(ENGINES), out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine') { opts.engines = [argv[i + 1]]; i += 1; }
    else if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else opts.files.push(argv[i]);
  }
  for (const e of opts.engines) if (!ENGINES[e]) throw new Error(`unknown engine: ${e}`);
  if (opts.files.length === 0) throw new Error('計測対象の HTML を 1 つ以上指定してください');
  for (const f of opts.files) if (!existsSync(f)) throw new Error(`ファイルがありません: ${f}`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const records = [];

for (const engineName of opts.engines) {
  const browser = await ENGINES[engineName].launch();
  const context = await browser.newContext();

  for (const file of opts.files) {
    const page = await context.newPage();
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });

    const outline = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
      return nodes.map((el) => ({
        level: el.hasAttribute('aria-level')
          ? Number(el.getAttribute('aria-level'))
          : Number(el.tagName.slice(1)) || null,
        text: el.textContent.trim().slice(0, 40)
      }));
    });

    // 段が飛んだ箇所（前の見出しより 2 段以上下がった位置）を数える
    const skips = [];
    for (let i = 1; i < outline.length; i += 1) {
      const gap = outline[i].level - outline[i - 1].level;
      if (gap > 1) skips.push({ from: outline[i - 1], to: outline[i], gap });
    }

    const landmarks = await page.evaluate(() => ({
      main: document.querySelectorAll('main, [role="main"]').length,
      nav: document.querySelectorAll('nav, [role="navigation"]').length,
      header: document.querySelectorAll('body > header, [role="banner"]').length,
      footer: document.querySelectorAll('body > footer, [role="contentinfo"]').length
    }));

    const tables = await page.evaluate(() =>
      [...document.querySelectorAll('table')].map((t) => {
        const th = [...t.querySelectorAll('th')];
        return {
          caption: t.querySelector('caption')?.textContent.trim() ?? null,
          thCount: th.length,
          thWithScope: th.filter((e) => e.hasAttribute('scope')).length,
          scopes: th.map((e) => e.getAttribute('scope')),
          rows: t.rows.length
        };
      })
    );

    let ariaSnapshot = null;
    try {
      ariaSnapshot = (await page.locator('body').ariaSnapshot()).trim();
    } catch (error) {
      ariaSnapshot = `取得できず: ${error.message.split('\n')[0]}`;
    }

    records.push({
      engine: engineName,
      browserVersion: browser.version(),
      file,
      outline,
      headingSkips: skips,
      landmarks,
      tables,
      ariaSnapshot
    });

    await page.close();
  }

  await context.close();
  await browser.close();
}

const table = records.map((r) => ({
  engine: r.engine,
  file: r.file.split('/').slice(-2).join('/'),
  見出し: r.outline.map((h) => `h${h.level}`).join(' '),
  段飛び: r.headingSkips.length,
  main: r.landmarks.main,
  caption: r.tables.length ? (r.tables[0].caption ? 'あり' : 'なし') : '—',
  th: r.tables.length ? r.tables[0].thCount : '—',
  'th[scope]': r.tables.length ? r.tables[0].thWithScope : '—'
}));
console.table(table);

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify({ measuredAt: new Date().toISOString(), records }, null, 2));
  console.log(`\n生データ: ${opts.out}`);
}
