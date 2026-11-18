// Generates a fictional multi-page PDF (with headings and running headers) for the browser tests.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const para = (n) => `<p>Paragraph ${n} of the fictional opinion explains the rule in plain terms. See Fed. R. Civ. P. 26(b)(1). The court then applies the rule to the facts and reaches a narrow result that continues onto the next line to test wrapping behavior.</p>`;
const html = `<html><head><style>
  body { font: 12pt Times, serif; margin: 0; } p { margin: 0 0 14pt; text-indent: 24pt; line-height: 1.5; }
  h2 { font-size: 13pt; margin: 18pt 0 10pt; }
</style></head><body>
<h2>I. BACKGROUND</h2>${[1, 2, 3, 4, 5, 6].map(para).join('')}
<h2>II. DISCUSSION</h2>${[7, 8, 9, 10, 11, 12, 13, 14].map(para).join('')}
<p>The motion to compel is granted in part.</p>
</body></html>`;

const b = await chromium.launch();
const page = await b.newPage();
await page.setContent(html);
await page.pdf({
  path: fileURLToPath(new URL('./fixtures/fictional_opinion.pdf', import.meta.url)),
  format: 'Letter', margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' },
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:9pt;width:100%;text-align:center">Fictional v. Sample, No. 00-0000</div>',
  footerTemplate: '<div style="font-size:9pt;width:100%;text-align:center"><span class="pageNumber"></span></div>',
});
await b.close();
