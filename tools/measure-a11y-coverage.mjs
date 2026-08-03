/**
 * measure-a11y-coverage.mjs — 同じページを複数の手段に通し、数え方ごとの件数を並べる
 *
 * 使い方:
 *   node tools/measure-a11y-coverage.mjs <file.html> [<file.html> ...]
 *   node tools/measure-a11y-coverage.mjs --out tools/results/006-coverage.json <files...>
 *
 * 測るもの（1 ページあたり）:
 *   1. axe-core     … 違反ルール数 / 該当要素数 / 部品単位の件数 / 紐づく達成基準の種類 / WCAG 外の違反数
 *   2. html-validate… 指摘件数とルール名（a11y 系のルールがどこまで含まれるかを見る）
 *   3. Lighthouse   … accessibility スコア / 監査項目の内訳（fail / pass / 対象外 / 人が確認）
 *
 * 3 手段を 1 つの JSON にまとめる理由:
 *   同じページでも「何を 1 件と数えるか」で結果が変わる。ルール単位・要素単位・部品単位を
 *   別々のハーネスで測ると、あとから突き合わせるときに条件がずれる。1 回の実行で同じページ・
 *   同じ版に対して全部を取り、突き合わせを機械的に検算できる状態にする。
 *
 * Lighthouse にローカルサーバが必要な理由:
 *   Lighthouse 13.4.1 は file:// の URL を受け付けない（normalizeUrl で失敗する）。
 *   axe と html-validate はファイルのまま測れるが、条件を揃えるため 3 手段すべて同じ
 *   HTTP URL に対して実行する。
 *
 * 依存: playwright / axe-core / html-validate / lighthouse（すべて devDependencies）
 */

import { chromium } from 'playwright';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { HtmlValidate } from 'html-validate';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const AXE_VERSION = require('axe-core/package.json').version;
const LH_VERSION = require('lighthouse/package.json').version;
const HV_VERSION = require('html-validate/package.json').version;

function parseArgs(argv) {
  const opts = { out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else opts.files.push(argv[i]);
  }
  if (opts.files.length === 0) throw new Error('測定対象の HTML ファイルを 1 つ以上指定してください');
  return opts;
}

/** 指定ファイル群だけを配る最小のサーバ（Lighthouse が file:// を受け付けないため） */
function startServer(files) {
  const bodies = new Map(files.map((f) => [`/${basename(f)}`, readFileSync(resolve(f), 'utf-8')]));
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const body = bodies.get(req.url);
      if (body === undefined) { resp.writeHead(404).end('not found'); return; }
      resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

/** 同じ間違いが同じ形で繰り返されている場合に 1 件と数える（数字と空白を正規化して重複を落とす） */
function componentKey(ruleId, html) {
  return `${ruleId}|${html.replace(/[0-9]+/g, 'N').replace(/\s+/g, ' ').trim()}`;
}

const opts = parseArgs(process.argv.slice(2));
const { server, port } = await startServer(opts.files);
const axeSource = readFileSync(AXE_PATH, 'utf-8');
const htmlvalidate = new HtmlValidate({ extends: ['html-validate:recommended'] });

process.env.CHROME_PATH ??= chromium.executablePath();
const browser = await chromium.launch();
const chrome = await launch({ chromeFlags: ['--headless=new'] });
const records = [];

for (const file of opts.files) {
  const url = `http://127.0.0.1:${port}/${basename(file)}`;

  // --- 1. axe-core ---
  const page = await browser.newPage();
  await page.goto(url);
  await page.addScriptTag({ content: axeSource });
  const axeRaw = await page.evaluate(async () => {
    const run = await window.axe.run();
    const shape = (arr) => arr.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags, html: v.nodes.map((n) => n.html) }));
    return {
      violations: shape(run.violations),
      passCount: run.passes.length,
      incompleteCount: run.incomplete.length,
      inapplicableCount: run.inapplicable.length
    };
  });
  await page.close();

  const isSC = (t) => /^wcag[0-9]{3,4}$/.test(t);
  const scKinds = new Set();
  const components = new Set();
  let nonWcagRules = 0;
  let nodeCount = 0;
  for (const v of axeRaw.violations) {
    const scs = v.tags.filter(isSC);
    scs.forEach((t) => scKinds.add(t));
    if (scs.length === 0) nonWcagRules += 1;
    nodeCount += v.html.length;
    v.html.forEach((h) => components.add(componentKey(v.id, h)));
  }

  // --- 2. html-validate ---
  const hvReport = await htmlvalidate.validateFile(resolve(file));
  const hvMessages = hvReport.results.flatMap((r) => r.messages.map((m) => ({ rule: m.ruleId, line: m.line, column: m.column })));

  // --- 3. Lighthouse ---
  const lh = await lighthouse(url, { port: chrome.port, output: 'json', onlyCategories: ['accessibility'], logLevel: 'error' });
  const cat = lh.lhr.categories.accessibility;
  const audits = lh.lhr.audits;
  const byMode = (mode) => cat.auditRefs.filter((r) => audits[r.id]?.scoreDisplayMode === mode).map((r) => r.id);
  const failIds = cat.auditRefs.filter((r) => audits[r.id]?.score === 0).map((r) => r.id);
  const passIds = cat.auditRefs.filter((r) => audits[r.id]?.score === 1).map((r) => r.id);

  const record = {
    file,
    axe: {
      ruleCount: axeRaw.violations.length,
      nodeCount,
      componentCount: components.size,
      successCriteriaKinds: [...scKinds].sort(),
      nonWcagRuleCount: nonWcagRules,
      passCount: axeRaw.passCount,
      incompleteCount: axeRaw.incompleteCount,
      inapplicableCount: axeRaw.inapplicableCount,
      evaluatedRuleCount: axeRaw.violations.length + axeRaw.passCount + axeRaw.incompleteCount + axeRaw.inapplicableCount,
      violations: axeRaw.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.html.length, wcagTagged: v.tags.some(isSC) }))
    },
    htmlValidate: { messageCount: hvMessages.length, rules: [...new Set(hvMessages.map((m) => m.rule))].sort(), messages: hvMessages },
    lighthouse: {
      score: cat.score === null ? null : Math.round(cat.score * 100),
      auditRefCount: cat.auditRefs.length,
      failCount: failIds.length,
      passCount: passIds.length,
      notApplicableCount: byMode('notApplicable').length,
      manualCount: byMode('manual').length,
      failIds,
      manualIds: byMode('manual')
    }
  };
  records.push(record);

  console.log(file);
  console.log(`  axe            : ルール ${record.axe.ruleCount} / 要素 ${record.axe.nodeCount} / 部品 ${record.axe.componentCount} / 達成基準 ${record.axe.successCriteriaKinds.length} 種（WCAG 外の違反 ${record.axe.nonWcagRuleCount}）`);
  console.log(`  html-validate  : ${record.htmlValidate.messageCount} 件（${record.htmlValidate.rules.join(', ') || 'なし'}）`);
  console.log(`  Lighthouse     : ${record.lighthouse.score} 点 / 監査 ${record.lighthouse.auditRefCount}（fail ${record.lighthouse.failCount} / pass ${record.lighthouse.passCount} / 対象外 ${record.lighthouse.notApplicableCount} / 人が確認 ${record.lighthouse.manualCount}）`);
}

await browser.close();
await chrome.kill();
server.close();

if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  const payload = {
    tool: 'tools/measure-a11y-coverage.mjs',
    versions: { axeCore: AXE_VERSION, lighthouse: LH_VERSION, htmlValidate: HV_VERSION },
    note: 'Lighthouse は file:// を受け付けないため、3 手段すべて同じローカル HTTP URL に対して測定した',
    records
  };
  writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
}
