// Renders scripts/og.html to public/og.png (1200x630) with the local Chrome.
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL('scripts/og.html').href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: 'public/og.png' });
await browser.close();
console.log('wrote public/og.png');
