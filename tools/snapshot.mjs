// 渡した HTML ファイルのアクセシビリティツリーを書き出す
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const browser = await chromium.launch();
const page = await browser.newPage();
for (const file of process.argv.slice(2)) {
  await page.goto(pathToFileURL(resolve(file)).href);
  console.log(`# ${file}`);
  console.log(await page.locator('body').ariaSnapshot());
}
await browser.close();
