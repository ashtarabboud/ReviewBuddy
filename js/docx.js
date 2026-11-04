// Minimal, dependency-free .docx text extractor. Runs entirely in the browser:
// the file is read from memory, unzipped with the built-in DecompressionStream,
// and parsed with DOMParser. Nothing is sent anywhere.

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot open .docx files (it needs iOS/Safari 16.4 or newer). Try pasting the text instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(buffer, wanted) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a Word (.docx) file. If it is password-protected, remove the password and try again.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('The .docx file appears to be damaged.');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const xlen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    if (name === wanted) {
      const lnlen = dv.getUint16(local + 26, true);
      const lxlen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      const data = u8.subarray(start, start + csize);
      if (method === 0) return dec.decode(data);
      if (method === 8) return dec.decode(await inflateRaw(data));
      throw new Error('Unsupported compression in .docx file.');
    }
    off += 46 + nlen + xlen + clen;
  }
  throw new Error('No document body found in this .docx file.');
}

function paragraphText(p) {
  let out = '';
  const visit = (node) => {
    for (const el of node.children) {
      const n = el.localName;
      if (n === 't') out += el.textContent;
      else if (n === 'tab' || n === 'br' || n === 'cr') out += ' ';
      else if (n === 'noBreakHyphen') out += '-';
      else if (n === 'softHyphen') continue;
      else if (n === 'txbxContent' || n === 'Fallback' || n === 'del' || n === 'moveFrom') continue;
      else if (n === 'p') continue; // nested paragraphs (text boxes) are handled elsewhere
      else visit(el);
    }
  };
  visit(p);
  return out;
}

function collectParagraphs(node, out) {
  for (const el of node.children) {
    const n = el.localName;
    if (el.namespaceURI !== W_NS) {
      if (n === 'AlternateContent') continue;
      collectParagraphs(el, out);
      continue;
    }
    if (n === 'p') out.push(paragraphText(el));
    else if (n === 'sectPr') continue;
    else collectParagraphs(el, out); // tables, rows, cells, content controls, etc.
  }
}

export function paragraphsFromDocumentXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read the Word document contents.');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('No document body found in this .docx file.');
  const out = [];
  collectParagraphs(body, out);
  return out.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export async function extractDocxParagraphs(arrayBuffer) {
  const xml = await readZipEntry(arrayBuffer, 'word/document.xml');
  return paragraphsFromDocumentXml(xml);
}
