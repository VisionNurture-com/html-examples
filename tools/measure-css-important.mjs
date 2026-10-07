// html-basics 003: `!important` を付けても効かないのはどんなときかを測る。
//
//   node tools/measure-css-important.mjs <chromium|firefox|webkit>
//
// 同じ要素 <p id="notice" class="alert"> に赤（.alert）と青（#notice）をぶつけ、採用された色を getComputedStyle で見る。
// 出力: JSON 1 行（標準出力）
import http from 'node:http';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)('playwright');
const RED = 'rgb(185, 28, 28)';
const BLUE = 'rgb(29, 78, 216)';
const GREEN = 'rgb(21, 128, 61)';

const CASES = {
  'control（どちらも付けない）': { css: `.alert { color: ${RED}; }\n#notice { color: ${BLUE}; }` },
  '弱い側だけに付ける': { css: `.alert { color: ${RED} !important; }\n#notice { color: ${BLUE}; }` },
  '両方に付ける（強さが違う）': { css: `.alert { color: ${RED} !important; }\n#notice { color: ${BLUE} !important; }` },
  '両方に付ける（強さが同じ・後ろが青）': { css: `.alert { color: ${RED} !important; }\n.notice { color: ${BLUE} !important; }`, cls: 'alert notice' },
  'style 属性にも付ける': { css: `.alert { color: ${RED} !important; }\n#notice { color: ${BLUE} !important; }`, style: `color: ${GREEN} !important` },
  '綴り違い（!importnt）': { css: `.alert { color: ${RED} !importnt; }\n#notice { color: ${BLUE}; }` },
};

function serve(html, css) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/style.css')) { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); return res.end(css); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const engine = process.argv[2];
const browser = await pw[engine].launch();
const out = { measuredAt: new Date().toISOString(), engine, version: browser.version(), cases: [] };
const name = (c) => (c === RED ? '赤（.alert）' : c === BLUE ? '青（#notice / .notice）' : c === GREEN ? '緑（style 属性）' : c);
for (const [label, c] of Object.entries(CASES)) {
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="/style.css"></head><body><p id="notice" class="${c.cls ?? 'alert'}"${c.style ? ` style="${c.style}"` : ''}>お知らせ</p></body></html>`;
  const { server, base } = await serve(html, c.css);
  const page = await browser.newPage();
  await page.goto(base + '/');
  const color = await page.$eval('p', (e) => getComputedStyle(e).color);
  out.cases.push({ case: label, css: c.css, style: c.style ?? null, applied: name(color) });
  await page.close(); server.closeAllConnections(); server.close();
}
await browser.close();
console.log(JSON.stringify(out));
process.exit(0);
