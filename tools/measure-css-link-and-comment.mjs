// html-basics 003: CSS が「読み込まれない」入口（<link> の書き方）と、コメントの閉じ忘れを測る。
//
//   node tools/measure-css-link-and-comment.mjs <chromium|firefox|webkit>
//
// link: サーバに CSS の要求が届いたか（到着の有無）と、見出しの色が指定どおりかを見る。
// comment: コメントを閉じ忘れたとき、その後ろのどのルールが効かなくなるかを getComputedStyle で数える。
// 出力: JSON 1 行（標準出力）
import http from 'node:http';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)('playwright');
const BLUE = 'rgb(29, 78, 216)';

const LINKS = {
  correct: '<link rel="stylesheet" href="/style.css">',
  'no-rel': '<link href="/style.css">',
  'rel-typo': '<link rel="stylesheets" href="/style.css">',
  'href-typo': '<link rel="stylesheet" hrf="/style.css">',
  'no-link': '',
};
const COMMENTS = {
  control: 'h1 { color: rgb(29, 78, 216); }\n/* 見出しの下線 */\nh2 { color: rgb(185, 28, 28); }\np { color: rgb(21, 128, 61); }\n',
  'unclosed-middle': 'h1 { color: rgb(29, 78, 216); }\n/* 見出しの下線\nh2 { color: rgb(185, 28, 28); }\np { color: rgb(21, 128, 61); }\n',
  'closed-wrong': 'h1 { color: rgb(29, 78, 216); }\n/* 見出しの下線 *\nh2 { color: rgb(185, 28, 28); }\np { color: rgb(21, 128, 61); }\n',
};

function serve(head, css) {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/style.css')) { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); return res.end(css); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>t</title>${head}</head><body><h1>見出し</h1><h2>小見出し</h2><p>本文</p></body></html>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

const engine = process.argv[2];
const browser = await pw[engine].launch();
const out = { measuredAt: new Date().toISOString(), engine, version: browser.version(), link: [], comment: [] };
for (const [name, head] of Object.entries(LINKS)) {
  const { server, hits, base } = await serve(head, `h1 { color: ${BLUE}; }`);
  const page = await browser.newPage();
  await page.goto(base + '/'); await page.waitForTimeout(300);
  const color = await page.$eval('h1', (e) => getComputedStyle(e).color);
  out.link.push({ case: name, head, requested: hits.length > 0, applied: color === BLUE });
  await page.close(); server.closeAllConnections(); server.close();
}
for (const [name, css] of Object.entries(COMMENTS)) {
  const { server, base } = await serve('<link rel="stylesheet" href="/style.css">', css);
  const page = await browser.newPage();
  await page.goto(base + '/');
  const got = await page.evaluate(() => Object.fromEntries(['h1', 'h2', 'p'].map((s) => [s, getComputedStyle(document.querySelector(s)).color])));
  out.comment.push({ case: name, h1: got.h1 === 'rgb(29, 78, 216)', h2: got.h2 === 'rgb(185, 28, 28)', p: got.p === 'rgb(21, 128, 61)' });
  await page.close(); server.closeAllConnections(); server.close();
}
await browser.close();
console.log(JSON.stringify(out));
process.exit(0);
