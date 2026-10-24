// Prints the resume pages (print stylesheet) to A4 PDFs in public/downloads/.
// Usage: npm run build && npm run preview  (in another terminal)  →  npm run resume:pdf
// Needs Google Chrome installed (playwright-core drives the local Chrome, no browser download).
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4321';
const jobs = [
  { path: '/curriculo/', out: 'public/downloads/jefferson-valandro-curriculo.pdf' },
  { path: '/en/resume/', out: 'public/downloads/jefferson-valandro-resume.pdf' },
];

const browser = await chromium.launch({ channel: 'chrome' });
for (const { path, out } of jobs) {
  const page = await browser.newPage({ colorScheme: 'light' });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  // The e-mail is only assembled on click; the PDF needs it as text.
  await page.click('.cv button.email');
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: out, format: 'A4', printBackground: false, preferCSSPageSize: true });
  console.log('wrote', out);
  await page.close();
}
await browser.close();
