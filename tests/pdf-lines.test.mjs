// Unit tests for rebuilding paragraphs from PDF lines (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesToParagraphs } from '../js/pdf.js';

// Build a page of lines: [text, x, size?, extraGap?]; y decreases by 14pt per line plus any extra gap.
function page(rows, top = 700) {
  let y = top;
  return rows.map(([text, x = 72, size = 12, gap = 0]) => {
    y -= 14 + gap;
    return { text, x, y, size, right: x + text.length * 6 };
  });
}
const FULL = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod'; // ~70 chars

test('joins wrapped lines; splits on gaps, short lines, indents, size changes and headings', () => {
  const paras = linesToParagraphs([page([
    ['I. BACKGROUND', 72, 13],                     // bigger heading
    [`${FULL} See Fed. R. Civ. P.`, 96],           // abbreviation at line end: not a paragraph end
    [`26(b)(1). ${FULL}`, 72],
    ['ends here.', 72],                            // short last line ends the paragraph
    [`Second paragraph ${FULL}`, 72],
    [`${FULL} full width ends.`, 72],              // full-width line ending a sentence...
    ['II. DISCUSSION', 72, 12],                    // ...then a same-size heading
    [`Indented start ${FULL}`, 96],
    [`lowercase continuation ${FULL}`, 72],
    [`After a gap ${FULL}`, 72, 12, 20],
  ])]);
  assert.deepEqual(paras.map((p) => p.split(' ').slice(0, 2).join(' ')), [
    'I. BACKGROUND', 'Lorem ipsum', 'Second paragraph', 'II. DISCUSSION', 'Indented start', 'After a',
  ]);
  assert.match(paras[1], /See Fed\. R\. Civ\. P\. 26\(b\)\(1\)\. .* ends here\.$/);
  assert.match(paras[4], /lowercase continuation/);
});

test('drops running headers, page numbers, and joins paragraphs split across pages', () => {
  const pages = [1, 2, 3].map((n) => page([
    ['Smith v. Jones, No. 12-345', 200, 9],
    [`Page ${n} text ${FULL}`, 72],
    [`that runs onto the next page and ${FULL}`, 72],
    [String(n), 300, 9],
  ]));
  const paras = linesToParagraphs(pages);
  assert.ok(paras.every((p) => !/Smith v\. Jones/.test(p)), 'header not removed');
  assert.ok(paras.every((p) => !/^\d+$/.test(p)), 'page number not removed');
  assert.equal(paras.length, 3);
  assert.match(paras[1], /^Page 2 text/);
});
