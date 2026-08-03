// 画像属性が LCP / CLS に与える影響を測る。
//
// Lighthouse は使わない。simulate（Lantern 推定）法は遅延読み込み画像の CLS を
// 取りこぼすため、PerformanceObserver の実測を正本とする。
// 帯域はサーバ側の共有トークンバケットで絞る（理由は下の THROTTLE のコメント）。
//
//   node tools/measure-cwv.mjs                 # LCP / CLS を測る（既定 7 回・中央値）
//   node tools/measure-cwv.mjs --runs 5
//   node tools/measure-cwv.mjs --mode content-type   # Content-Type と nosniff の組み合わせ
//
// 出力: tools/results/007-cwv.json / tools/results/007-content-type.json

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'tools', 'results');

// スロットリング条件。記事にはこの値をそのまま載せる。
//
// 🔴 CDP の Network.emulateNetworkConditions は使わない。
// 本環境（chromium 151.0.7922.34 / headless）では、これを有効化した瞬間に
// 画像が LCP 候補として記録されなくなる（8 Mbps / 20ms のような緩い条件でも同じ）。
// 帯域はサーバ側で絞る。詳細は tools/results/007-lcp-harness-probe.json を参照。
const THROTTLE = {
  latencyMs: 150,                                        // 応答開始までの遅延（往復相当）
  bytesPerSecond: Math.round(1.6 * 1024 * 1024 / 8),     // 1.6 Mbps
  chunkMs: 20,                                           // 送出間隔
};
const CPU_THROTTLING_RATE = 4;
const VIEWPORT = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * 帯域をサーバ全体で共有するトークンバケット。
 * リクエストごとに独立して絞ると帯域の奪い合いが起きず、優先度ヒントの効果が現れない。
 */
function createBucket({ bytesPerSecond, chunkMs }) {
  const perTick = Math.max(1, Math.round(bytesPerSecond * chunkMs / 1000));
  let available = perTick;
  const waiters = [];
  const timer = setInterval(() => {
    available = Math.min(perTick * 2, available + perTick);
    while (waiters.length && available > 0) waiters.shift()();
  }, chunkMs);
  timer.unref?.();
  return {
    async take(max) {
      while (available <= 0) await new Promise((r) => waiters.push(r));
      const n = Math.min(max, available);
      available -= n;
      return n;
    },
    stop() { clearInterval(timer); },
  };
}

/** 静的サーバ。overrides で特定パスのヘッダを差し替えられる。throttle 指定時は帯域をサーバ側で絞る。 */
function startServer(overrides = {}, throttle = null) {
  const bucket = throttle ? createBucket(throttle) : null;
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
    const filePath = join(ROOT, rel);
    const override = overrides[urlPath];
    let body;
    if (override?.body !== undefined) {
      body = override.body;
    } else {
      try {
        body = await readFile(filePath);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
    }
    const headers = { 'content-type': override?.contentType ?? MIME[extname(filePath)] ?? 'application/octet-stream' };
    if (override?.nosniff) headers['x-content-type-options'] = 'nosniff';
    headers['cache-control'] = 'no-store';

    if (!throttle) {
      res.writeHead(200, headers);
      res.end(body);
      return;
    }
    await sleep(throttle.latencyMs);
    res.writeHead(200, { ...headers, 'content-length': String(body.length) });
    let off = 0;
    while (off < body.length) {
      if (!res.writable) return;
      const n = await bucket.take(body.length - off);
      res.write(body.subarray(off, off + n));
      off += n;
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => { bucket?.stop(); server.close(); },
    }));
  });
}

const OBSERVER = () => {
  window.__cwv = { lcp: null, lcpElement: null, lcpUrl: null, lcpSize: null, cls: 0, shifts: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__cwv.lcp = e.startTime;
      window.__cwv.lcpSize = e.size;
      window.__cwv.lcpUrl = e.url || null;
      window.__cwv.lcpElement = e.element
        ? e.element.tagName.toLowerCase() + (e.element.getAttribute('src') ? `[src=${e.element.getAttribute('src')}]` : '')
        : null;
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.hadRecentInput) { window.__cwv.cls += e.value; window.__cwv.shifts += 1; }
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

async function measureOnce(browser, url) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript(OBSERVER);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING_RATE });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000); // 遅延到着ぶんのシフトを取りこぼさないための待機
  const cwv = await page.evaluate(() => window.__cwv);
  await context.close();
  return cwv;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 3) => Number(n.toFixed(d));

async function modeCwv(runs) {
  const BASE = 'compare/007-loading-vs-fetchpriority';
  const impls = [
    ['A', '属性なし（baseline）', 'a-baseline.html'],
    ['B', '主役に fetchpriority="high"', 'b-fetchpriority.html'],
    ['C', '4 枚すべてに fetchpriority="high"', 'c-fetchpriority-multi.html'],
    ['D', 'link rel="preload"', 'd-preload.html'],
    ['E', '全画像に loading="lazy"', 'e-lazy-all.html'],
  ];
  const variants = [
    ...impls.map(([id, label, f]) => ({ id: `simple-${id}`, label: `競合なし ${id} — ${label}`, file: `${BASE}/simple/${f}` })),
    ...impls.map(([id, label, f]) => ({ id: `heavy-${id}`, label: `競合あり ${id} — ${label}`, file: `${BASE}/heavy/${f}` })),
    { id: 'S3-broken', label: '症状 3 broken（width/height なし）', file: 'symptoms/007-layout-shift/broken.html' },
    { id: 'S3-fixed', label: '症状 3 fixed（width/height あり）', file: 'symptoms/007-layout-shift/fixed.html' },
  ];

  const { port, close } = await startServer({}, THROTTLE);
  const browser = await chromium.launch();
  const results = [];
  for (const v of variants) {
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
      samples.push(await measureOnce(browser, `http://127.0.0.1:${port}/${v.file}`));
    }
    const lcps = samples.map((s) => s.lcp).filter((x) => typeof x === 'number');
    const clss = samples.map((s) => s.cls);
    results.push({
      id: v.id,
      label: v.label,
      file: v.file,
      runs,
      lcpMedianMs: lcps.length ? round(median(lcps), 1) : null,
      lcpSamplesMs: lcps.map((x) => round(x, 1)),
      clsMedian: round(median(clss), 4),
      clsSamples: clss.map((x) => round(x, 4)),
      lcpElement: samples.at(-1).lcpElement,
      lcpUrl: samples.at(-1).lcpUrl,
      shiftCountMedian: median(samples.map((s) => s.shifts)),
    });
    process.stdout.write(`${v.id}: LCP ${results.at(-1).lcpMedianMs} ms / CLS ${results.at(-1).clsMedian} / LCP 要素 ${results.at(-1).lcpElement}\n`);
  }
  await browser.close();
  close();

  return {
    measuredAt: new Date().toISOString(),
    tool: 'playwright chromium + サーバ側スロットリング + PerformanceObserver',
    conditions: { throttle: THROTTLE, cpuThrottlingRate: CPU_THROTTLING_RATE, viewport: VIEWPORT, runs },
    note: [
      'Lighthouse は使用しない（simulate 法は遅延読み込み画像の CLS を取りこぼすため）',
      'CDP の Network.emulateNetworkConditions も使用しない（本環境では画像が LCP 候補として記録されなくなるため）',
    ],
    results,
  };
}

/**
 * 中身と Content-Type と nosniff の組み合わせで、ブラウザが画像として扱うかを測る。
 *
 * 🔴 症状ページ（symptoms/007-content-type-mismatch/broken.html）に依存させない。
 * 初版は broken.html を読み込み、そこが参照する images/photo.jpg を override する
 * 作りだった。その後 broken.html は images/logo.txt を参照する形へ作り直されたため
 * （SVG の Content-Type 不一致でサンプルを再構成）、override が当たらなくなり
 * 全ケースが rendered=false という無意味な結果を書き出すようになっていた。
 * 症状ページの作り替えで測定が壊れないよう、ページも対象も合成して自己完結させる。
 */
async function modeContentType() {
  const cases = [
    { id: 1, label: '中身 PNG / Content-Type: image/jpeg / nosniff なし', contentType: 'image/jpeg', nosniff: false },
    { id: 2, label: '中身 PNG / Content-Type: image/jpeg / nosniff あり', contentType: 'image/jpeg', nosniff: true },
    { id: 3, label: '中身 PNG / Content-Type: text/plain / nosniff なし', contentType: 'text/plain', nosniff: false },
    { id: 4, label: '中身 PNG / Content-Type: text/plain / nosniff あり', contentType: 'text/plain', nosniff: true },
    { id: 5, label: '中身 PNG / Content-Type: image/png / nosniff あり（対照）', contentType: 'image/png', nosniff: true },
    { id: 7, label: '中身 SVG / Content-Type: text/plain', contentType: 'text/plain', body: 'svg' },
    { id: 8, label: '中身 SVG / Content-Type: image/svg+xml（対照）', contentType: 'image/svg+xml', body: 'svg' },
    { id: 9, label: '中身 HTML エラーページ / Content-Type: image/jpeg（200 で返る）', contentType: 'image/jpeg', body: 'html' },
    { id: 10, label: '0 バイト / Content-Type: image/jpeg', contentType: 'image/jpeg', body: 'empty' },
  ];

  const IMAGES = join(ROOT, 'symptoms', '007-content-type-mismatch', 'images');
  const PNG = await readFile(join(IMAGES, 'photo.jpg'));           // 名前は .jpg・中身は PNG
  const JPEG = await readFile(join(IMAGES, 'photo-correct.jpg'));  // 名前も中身も JPEG（対照）
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#4682b4"/></svg>');
  const HTML = Buffer.from('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
  const BODIES = { svg: SVG, html: HTML, empty: Buffer.alloc(0) };

  // 合成ページ。症状ページと同じ形（<img> 1 枚）だがディスク上のファイルには依存しない。
  const PAGE_PATH = '/__content-type-probe.html';
  const TARGET_PATH = '/__content-type-target';
  const PAGE = Buffer.from(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>Content-Type プローブ</title></head>`
    + `<body><img src="${TARGET_PATH}" alt="サンプルのロゴ"></body></html>`,
  );

  const browser = await chromium.launch();
  const results = [];

  const probe = async (overrideForTarget) => {
    const { server, port } = await startServer({
      [PAGE_PATH]: { body: PAGE, contentType: 'text/html; charset=utf-8' },
      [TARGET_PATH]: overrideForTarget,
    });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const resp = [];
    page.on('response', (r) => { if (r.url().endsWith(TARGET_PATH)) resp.push({ status: r.status(), headers: r.headers() }); });
    await page.goto(`http://127.0.0.1:${port}${PAGE_PATH}`, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => {
      const img = document.querySelector('img');
      return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete };
    });
    await context.close();
    server.close();
    return { resp, shown, consoleErrors };
  };

  for (const c of cases) {
    const { resp, shown, consoleErrors } = await probe({
      contentType: c.contentType,
      nosniff: c.nosniff,
      body: c.body ? BODIES[c.body] : PNG,
    });
    results.push({
      ...c,
      httpStatus: resp[0]?.status ?? null,
      sentContentType: resp[0]?.headers['content-type'] ?? null,
      sentNosniff: resp[0]?.headers['x-content-type-options'] ?? null,
      naturalWidth: shown.naturalWidth,
      rendered: shown.naturalWidth > 0,
      consoleErrors,
    });
    process.stdout.write(`case ${c.id}: rendered=${shown.naturalWidth > 0} (naturalWidth=${shown.naturalWidth})\n`);
  }

  // 対照: 名前と中身が一致した本物の JPEG
  {
    const { shown } = await probe({ contentType: 'image/jpeg', body: JPEG });
    results.push({
      id: 6,
      label: 'fixed.html（中身 JPEG / Content-Type: image/jpeg）',
      naturalWidth: shown.naturalWidth,
      rendered: shown.naturalWidth > 0,
    });
    process.stdout.write(`case 6 (fixed): rendered=${shown.naturalWidth > 0} (naturalWidth=${shown.naturalWidth})\n`);
  }

  await browser.close();
  return { measuredAt: new Date().toISOString(), target: TARGET_PATH, results };
}

/**
 * 各リソースにブラウザが割り当てた優先度を記録する。fetchpriority の効き方を説明する材料。
 *
 * heavy-D2 は「`<link rel="preload">` を単体で書いた場合」の対照。d-preload.html の
 * preload 行から fetchpriority だけを外した版をメモリ上で配信する。リポジトリに
 * 記事非掲載の HTML を増やさないため、ファイルは作らず override で差し替える
 * （記事内自己完結の制約により、リポジトリ固有のファイルは足さない）。
 */
async function modePriority() {
  const BASE = 'compare/007-loading-vs-fetchpriority';
  const D2_PATH = `/${BASE}/heavy/__d2-preload-only.html`;   // ディスク上に実体は持たない
  const d2Source = await readFile(join(ROOT, BASE, 'heavy', 'd-preload.html'), 'utf8');
  const d2Body = d2Source.replace(
    /(<link rel="preload"[^>]*?)\s+fetchpriority="high"/,
    '$1',
  );

  // 検算は preload の <link> 要素に限定する。`rel="preload"` だけで行を選ぶと
  // <title>競合あり D — link rel="preload"</title> を拾って検査が空振りする。
  const linkLine = (s) => s.split('\n').find((l) => l.includes('<link rel="preload"')) ?? '';
  if (d2Body === d2Source) throw new Error('D2: preload 行の fetchpriority を除去できなかった');
  if (!linkLine(d2Body)) throw new Error('D2: preload の <link> 要素を特定できなかった');
  if (linkLine(d2Body).includes('fetchpriority')) throw new Error('D2: <link> に fetchpriority が残存');
  if (!linkLine(d2Source).includes('fetchpriority="high"')) throw new Error('D2: 対照元の <link> に fetchpriority がない');

  const files = [
    { id: 'simple-A', file: `${BASE}/simple/a-baseline.html` },
    { id: 'simple-B', file: `${BASE}/simple/b-fetchpriority.html` },
    { id: 'heavy-A', file: `${BASE}/heavy/a-baseline.html` },
    { id: 'heavy-B', file: `${BASE}/heavy/b-fetchpriority.html` },
    { id: 'heavy-C', file: `${BASE}/heavy/c-fetchpriority-multi.html` },
    { id: 'heavy-D', file: `${BASE}/heavy/d-preload.html` },
    {
      id: 'heavy-D2',
      file: `${BASE}/heavy/d-preload.html`,
      servedAs: D2_PATH.replace(/^\//, ''),
      transform: 'preload 行から fetchpriority="high" を除去（メモリ上配信・ディスクは不変）',
      appliedLink: linkLine(d2Body).trim(),
    },
    { id: 'heavy-E', file: `${BASE}/heavy/e-lazy-all.html` },
  ];
  const { port, close } = await startServer(
    { [D2_PATH]: { body: Buffer.from(d2Body), contentType: MIME['.html'] } },
    THROTTLE,
  );
  const browser = await chromium.launch();
  const results = [];
  for (const f of files) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const requests = [];
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => {
      requests.push({
        name: e.request.url.split('/').pop(),
        initialPriority: e.request.initialPriority,
        at: Math.round(e.timestamp * 1000) % 100000,
      });
    });
    await page.goto(`http://127.0.0.1:${port}/${f.servedAs ?? f.file}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(500);
    results.push({
      id: f.id,
      file: f.file,
      ...(f.transform ? { transform: f.transform, appliedLink: f.appliedLink } : {}),
      requests,
    });
    process.stdout.write(`${f.id.padEnd(10)} ${requests.map((r) => `${r.name}=${r.initialPriority}`).join(' / ')}\n`);
    await context.close();
  }
  await browser.close();
  close();
  return { measuredAt: new Date().toISOString(), note: 'initialPriority は CDP Network.requestWillBeSent の値', results };
}

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'cwv';
const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 7;

await mkdir(RESULTS, { recursive: true });
if (mode === 'priority') {
  const out = await modePriority();
  await writeFile(join(RESULTS, '007-priority.json'), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write('→ tools/results/007-priority.json\n');
} else if (mode === 'content-type') {
  const out = await modeContentType();
  await writeFile(join(RESULTS, '007-content-type.json'), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write('→ tools/results/007-content-type.json\n');
} else {
  const out = await modeCwv(runs);
  await writeFile(join(RESULTS, '007-cwv.json'), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write('→ tools/results/007-cwv.json\n');
}
