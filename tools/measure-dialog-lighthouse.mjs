/**
 * measure-dialog-lighthouse.mjs — 閉じ方の要件を自動検査が拾わないことを測る（反例用）
 *
 * 使い方:
 *   node tools/measure-dialog-lighthouse.mjs
 *   node tools/measure-dialog-lighthouse.mjs --out tools/results/004-lighthouse.json
 *
 * 測るもの: compare/004-close-control/ の各実装に対する
 *   ① Lighthouse の accessibility スコア
 *   ② 失敗した監査項目の id 一覧
 *   ③ axe-core の violations 件数とルール id
 *
 * 🔴 スコアを達成と同視しない。
 *   ここで測るのは「点が高いこと」ではなく「Esc が効かない / 復帰しない / 背面が
 *   スクロールする実装でも点が下がらない」という射程の限界そのもの。
 *
 * ⚠️ Lighthouse 13.4.1 は file:// と data: を受け付けない。
 *   最小 HTTP サーバを内蔵し、全実装を同じ HTTP URL に対して測る。
 *
 * 依存: lighthouse / playwright / axe-core（devDependencies）
 */

import lighthouse from 'lighthouse';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = 'compare/004-close-control';
const FILES = ['a-custom.html', 'b-dialog.html', 'c-closedby-any.html', 'd-details.html', 'e-popover.html'];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function runAxe(page, url) {
  await page.goto(url);
  const src = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await page.addScriptTag({ content: src });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return { count: r.violations.length, rules: r.violations.map((v) => v.id), version: window.axe.version };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { server, port } = await startServer();
  const browser = await chromium.launch({ args: ['--remote-debugging-port=9222'] });
  const page = await browser.newPage();
  const results = { measuredAt: new Date().toISOString(), root: ROOT, chromium: browser.version(), targets: [] };

  for (const f of FILES) {
    const url = `http://127.0.0.1:${port}/${f}`;
    const lh = await lighthouse(url, { port: 9222, output: 'json', logLevel: 'error', onlyCategories: ['accessibility'] });
    const audits = lh.lhr.audits;
    const failed = Object.values(audits)
      .filter((a) => a.scoreDisplayMode === 'binary' && a.score === 0)
      .map((a) => a.id);
    const manual = Object.values(audits).filter((a) => a.scoreDisplayMode === 'manual').map((a) => a.id);
    const axe = await runAxe(page, url);
    results.targets.push({
      file: f,
      lighthouseVersion: lh.lhr.lighthouseVersion,
      a11yScore: Math.round(lh.lhr.categories.accessibility.score * 100),
      failedAudits: failed,
      manualAuditCount: manual.length,
      axeViolations: axe.count,
      axeRules: axe.rules,
      axeVersion: axe.version
    });
    console.log(`${f.padEnd(22)} a11y=${results.targets.at(-1).a11yScore} 失敗監査=${failed.length}${failed.length ? `(${failed.join(',')})` : ''} 人が確認=${manual.length} axe違反=${axe.count}${axe.count ? `(${axe.rules.join(',')})` : ''}`);
  }

  await browser.close();
  server.close();
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${opts.out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
