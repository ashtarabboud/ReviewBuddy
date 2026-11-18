// On-device PDF text extraction using the locally bundled pdf.js (vendor/pdfjs).
// The PDF bytes are handed to pdf.js in memory; nothing is fetched or uploaded.

import { looksLikeHeading } from './parse.js';

let lib = null;
async function loadLib() {
  if (!lib) {
    lib = await import('../vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return lib;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Turn positioned text items into lines for one page.
function pageLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 10;
    if (!cur || Math.abs(y - cur.y) > size * 0.5) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { text: '', x, y, size, right: x };
    }
    if (it.str) {
      if (cur.text && x - cur.right > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += it.str;
      cur.right = x + (it.width || 0);
    }
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim();
  return lines;
}

// Line endings like "Civ. P." or "No." that end an abbreviation, not a sentence.
const ABBREV_END = /(?:^|[\s(])(?:[A-Z]|No|Nos|v|vs|Fed|Civ|Crim|Evid|Proc|Cal|Supp|App|Cir|Dist|Ct|Inc|Corp|Co|Ltd|Id|cf|al|p|pp|e\.g|i\.e|U\.S|Mr|Mrs|Ms|Dr|St|Sec|Art|Ch)\.$/;

const repeatKey =(t) => t.replace(/\d+/g, '#').toLowerCase();

export function linesToParagraphs(pages) {
  // Drop running headers/footers (identical text on many pages) and bare page numbers.
  const counts = new Map();
  for (const lines of pages) {
    const seen = new Set();
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      if (l.text.length > 80) continue; // running headers/footers are short
      const k = repeatKey(l.text);
      if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
    }
  }
  const minRepeat = Math.max(2, Math.ceil(pages.length * 0.5));
  const paras = [];
  for (const lines of pages) {
    const kept = lines.filter((l, i) => {
      if (/^(page\s*)?\d{1,4}(\s*of\s*\d{1,4})?$/i.test(l.text) || /^[-–]\s*\d{1,4}\s*[-–]$/.test(l.text)) return false;
      const edge = i < 2 || i >= lines.length - 2;
      return !(edge && l.text.length <= 80 && pages.length >= 2 && counts.get(repeatKey(l.text)) >= minRepeat);
    });
    if (!kept.length) continue;
    const gaps = [];
    for (let i = 1; i < kept.length; i++) {
      const g = kept[i - 1].y - kept[i].y;
      if (g > 0) gaps.push(g);
    }
    const lineGap = median(gaps) || kept[0].size * 1.2;
    const left = median(kept.map((l) => l.x));
    const maxRight = Math.max(...kept.map((l) => l.right));
    let buf = '';
    let prev = null;
    for (const l of kept) {
      let newPara = !prev;
      if (prev) {
        const gap = prev.y - l.y;
        // A line that stops well short of the margin (not just one long word short) often ends a paragraph.
        const shortPrev = prev.right < left + (maxRight - left) * 0.75;
        const indented = l.x > left + l.size * 1.2;
        const endsSentence = /[.:;?!"”)]$/.test(prev.text) && !ABBREV_END.test(prev.text);
        if (gap > lineGap * 1.35 || gap < 0) newPara = true;
        else if (endsSentence && (shortPrev || indented)) newPara = true;
        else if (Math.abs(l.size - prev.size) > 0.6) newPara = true;
        else if (looksLikeHeading(prev.text) || (looksLikeHeading(l.text) && endsSentenceOrHeading(prev.text))) newPara = true;
      }
      if (newPara) {
        if (buf) paras.push(buf);
        buf = l.text;
      } else if (/[A-Za-z]-$/.test(buf) && /^[a-z]/.test(l.text)) {
        buf += l.text; // word broken across lines
      } else {
        buf += ` ${l.text}`;
      }
      prev = l;
    }
    if (buf) paras.push(buf);
  }
  // A paragraph that continues across a page break: join when the previous one doesn't end a sentence.
  const merged = [];
  for (const p of paras) {
    const last = merged[merged.length - 1];
    if (last && !/[.:;?!"”)]$/.test(last) && /^[a-z(]/.test(p)) merged[merged.length - 1] = `${last} ${p}`;
    else merged.push(p);
  }
  return merged;
}

export async function extractPdfParagraphs(arrayBuffer) {
  const pdfjs = await loadLib();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.');
    throw new Error('Could not read this PDF.');
  }
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(pageLines(content.items));
    page.cleanup();
  }
  await doc.destroy();
  const paras = linesToParagraphs(pages);
  if (!paras.join('').trim()) throw new Error('This PDF has no selectable text (it may be a scan). Try a text-based PDF or paste the text.');
  return paras;
}
