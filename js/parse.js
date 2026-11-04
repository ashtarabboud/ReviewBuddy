// Pure text-processing functions (no DOM, no network). Shared by the app and the unit tests.

// Words that end in a period but usually do NOT end a sentence (legal citations, titles, etc.).
const ABBREVIATIONS = new Set([
  'fed', 'civ', 'crim', 'evid', 'proc', 'app', 'bankr', 'supp', 'cir', 'dist', 'ct', 'super',
  'cal', 'stat', 'ann', 'rev', 'reg', 'regs', 'admin', 'gov', 'govt', 'code', 'const', 'amend',
  'sec', 'secs', 'art', 'arts', 'ch', 'chs', 'cl', 'para', 'paras', 'subd', 'subds', 'pt', 'pts',
  'p', 'pp', 'n', 'nn', 'fn', 'vol', 'ed', 'eds', 'ex', 'exs', 'exh', 'exhs', 'dep', 'tr', 'decl',
  'inc', 'corp', 'co', 'ltd', 'bros', 'assn', "ass'n", 'dept', 'intl', 'natl', 'mfg', 'ins',
  'v', 'vs', 'cf', 'al', 'ibid', 'approx', 'misc', 'mun', 'ord', 'cent',
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'st', 'ave', 'blvd', 'hon', 'esq', 'prof',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const CLOSERS = /["'”’)\]»]/;
const TOKEN_STOP = /[\s(\["“‘]/;

function isNonTerminalPeriod(s, dotIndex, sentenceStart, nextIndex) {
  let i = dotIndex;
  while (i > sentenceStart && !TOKEN_STOP.test(s[i - 1])) i--;
  const token = s.slice(i, dotIndex);
  const bare = token.replace(/^[^A-Za-z0-9]+/, '');
  const lower = bare.toLowerCase();
  if (!bare) return false;
  if (ABBREVIATIONS.has(lower)) return true;
  if ((lower === 'no' || lower === 'nos') && /\d/.test(s[nextIndex])) return true; // "No. 5"
  if (/^[A-Za-z]$/.test(bare)) return true; // initials: "R." in "Fed. R. Civ. P."
  if (/^([A-Za-z]\.)+[A-Za-z]$/.test(bare)) return true; // "U.S", "e.g", "i.e"
  // A list number at the very start of a sentence: "1. Documents sufficient to..."
  if (/^(\d{1,3}|[ivxlc]{1,6}|[a-z])$/i.test(bare) && s.slice(sentenceStart, i).trim() === '') return true;
  return false;
}

function looksLikeSentenceStart(s, n) {
  const rest = s.slice(n, n + 6);
  if (/^\p{Lu}/u.test(rest)) return true;
  if (/^["'“‘(\[]\s?\p{Lu}/u.test(rest)) return true;
  if (/^[(\[]\s?([0-9]{1,2}|[a-z]|[ivx]{1,4})[)\]]/.test(rest)) return true; // "(a) ..." enumerations
  if (/^\d{1,2}[.)]\s+\p{Lu}/u.test(s.slice(n, n + 8))) return true; // "2. All emails" inline lists
  if (/^§/.test(rest)) return false;
  return false;
}

export function splitSentences(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  const re = /[.?!]+/g;
  let m;
  while ((m = re.exec(s))) {
    let end = m.index + m[0].length;
    while (end < s.length && CLOSERS.test(s[end])) end++;
    if (end >= s.length) break;
    if (s[end] !== ' ') continue;
    let n = end;
    while (n < s.length && s[n] === ' ') n++;
    if (n >= s.length) break;
    if (!looksLikeSentenceStart(s, n)) continue;
    if (m[0] === '.' && isNonTerminalPeriod(s, m.index, start, n)) continue;
    const piece = s.slice(start, end).trim();
    if (piece) out.push(piece);
    start = n;
    re.lastIndex = n;
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

// ---------- Plain text -> paragraphs ----------

export function paragraphsFromText(text) {
  const t = String(text).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const blocks = t.split(/\n[ \t]*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  // Detect hard-wrapped text (e.g. copied from an email): most lines inside multi-line blocks
  // end without terminal punctuation, so they are continuations rather than paragraphs.
  let inner = 0;
  let open = 0;
  for (const b of blocks) {
    if (b.length < 2) continue;
    for (let i = 0; i < b.length - 1; i++) {
      inner++;
      if (!/[.:;!?"”)]$/.test(b[i])) open++;
    }
  }
  const hardWrapped = blocks.length > 1 && inner > 0 && open / inner >= 0.5;
  const paras = [];
  for (const b of blocks) {
    if (hardWrapped) paras.push(b.join(' '));
    else paras.push(...b);
  }
  return paras;
}

// ---------- Paragraphs -> RFP sections ----------

const PREFIX = String.raw`((?:[A-Za-z'’,&\-]+\s+){0,6}?)`;
const KIND = String.raw`(?:(?:DOCUMENTS?\s+)?(?:REQUESTS?|DEMANDS?)(?:\s+FOR\s+(?:THE\s+)?(?:PRODUCTION|INSPECTION)(?:\s+(?:AND\s+INSPECTION\s+)?OF\s+DOCUMENTS(?:\s+AND\s+(?:TANGIBLE\s+)?THINGS)?)?)?|RFPS?)`;
const TAIL = String.raw`\s*(NO\.?|NOS\.?|NUMBER|#)?\s*(\d{1,4}[A-Z]?)\s*(?:[:.\-–—)]+\s*|$)([\s\S]*)$`;
const RESP_RE = new RegExp(String.raw`^\s*` + PREFIX + String.raw`RESPONSES?\s+(?:(?:TO|FOR)\s+)?` + KIND + TAIL, 'i');
const REQ_RE = new RegExp(String.raw`^\s*` + PREFIX + KIND + TAIL, 'i');
const BARE_RESP_RE = /^\s*((?:[A-Za-z'’,&\-]+\s+){0,4}?)RESPONSES?\s*([:.\-–—]+\s*|$)([\s\S]*)$/i;
const CLOSING_RE = /^(?:dated\b|date:|respectfully submitted|verification\b|certificate of service|proof of service|declaration of service|\/s\/)/i;

function isUpper(str) {
  return str === str.toUpperCase();
}

function matchHeading(re, text) {
  const m = re.exec(text);
  if (!m) return null;
  const [, prefix, marker, num, rest] = m;
  if (prefix && !isUpper(prefix)) return null;
  const head = text.slice(0, text.length - rest.length);
  if (!isUpper(head) && !marker && !/:\s*$/.test(head)) return null;
  return { num: num.toUpperCase(), rest: rest.trim() };
}

function matchBareResponse(text) {
  const m = BARE_RESP_RE.exec(text);
  if (!m) return null;
  const [, prefix, sep, rest] = m;
  if (prefix && !isUpper(prefix)) return null;
  const head = text.slice(0, text.length - rest.length);
  if (!isUpper(head) && !sep.includes(':')) return null;
  return { rest: rest.trim() };
}

export function detectSections(paragraphs) {
  const pre = [];
  const post = [];
  const rfps = [];
  const ids = new Set();
  let cur = null;
  let mode = 'pre';

  const newSection = (num) => {
    let id = `rfp-${num}`;
    let k = 2;
    while (ids.has(id)) id = `rfp-${num}-${k++}`;
    ids.add(id);
    const sec = { id, kind: 'rfp', number: num, label: `RFP No. ${num}`, request: [], response: [], hasResponse: false };
    rfps.push(sec);
    return sec;
  };

  for (const raw of paragraphs) {
    const t = String(raw).replace(/\s+/g, ' ').trim();
    if (!t) continue;

    const r = matchHeading(RESP_RE, t);
    if (r) {
      let target = cur && cur.number === r.num && !cur.hasResponse ? cur : null;
      if (!target) target = [...rfps].reverse().find((x) => x.number === r.num && !x.hasResponse) || newSection(r.num);
      target.hasResponse = true;
      cur = target;
      mode = 'response';
      if (r.rest) cur.response.push(r.rest);
      continue;
    }
    const q = matchHeading(REQ_RE, t);
    if (q) {
      cur = newSection(q.num);
      mode = 'request';
      if (q.rest) cur.request.push(q.rest);
      continue;
    }
    if (mode !== 'post') {
      const b = cur ? matchBareResponse(t) : null;
      if (b) {
        cur.hasResponse = true;
        mode = 'response';
        if (b.rest) cur.response.push(b.rest);
        continue;
      }
      if (cur && CLOSING_RE.test(t) && rfps.some((x) => x.response.length)) mode = 'post';
    }
    if (mode === 'pre') pre.push(t);
    else if (mode === 'post') post.push(t);
    else if (mode === 'request') cur.request.push(t);
    else cur.response.push(t);
  }

  if (!rfps.length) {
    return {
      structured: false,
      sections: [{ id: 'doc', kind: 'other', label: 'Document', request: [], response: pre }],
    };
  }
  const sections = [];
  if (pre.length) sections.push({ id: 'pre', kind: 'other', label: 'Text before the first request', request: [], response: pre });
  for (const s of rfps) sections.push({ id: s.id, kind: 'rfp', number: s.number, label: s.label, request: s.request, response: s.response });
  if (post.length) sections.push({ id: 'post', kind: 'other', label: 'Closing text (signature, verification, service)', request: [], response: post });
  return { structured: true, sections };
}

// Full pipeline: paragraphs -> sections whose responses are split into sentences.
export function buildReviewSections(paragraphs) {
  const { structured, sections } = detectSections(paragraphs);
  return {
    structured,
    sections: sections.map((s) => ({
      id: s.id,
      kind: s.kind,
      number: s.number || null,
      label: s.label,
      request: s.request,
      paras: s.response.map((p) => splitSentences(p)).filter((a) => a.length),
    })),
  };
}

export function normalize(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compress [1,2,3,5] -> "S1–S3, S5"
export function ranges(nums, prefix = 'S') {
  const n = [...nums].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `${prefix}${n[i]}–${prefix}${n[j]}` : `${prefix}${n[i]}`);
    i = j;
  }
  return out.join(', ');
}
