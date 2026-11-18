// ReviewBuddy — private, on-device document review.
// Two modes:
//   • Draft review: approve / refine / revise sentences of your own draft (e.g. RFP responses)
//     and get revision instructions for the next round.
//   • Document review: read someone else's document, highlight key points, mark passages to
//     research or explain, take notes, and get a ready-made prompt for Claude.
// All data lives in this browser's localStorage. There are no network calls,
// no analytics, and no third-party code beyond the locally bundled pdf.js. See README.md.

import { buildReviewSections, buildReadingSections, paragraphsFromText, normalize, ranges } from './parse.js';
import { extractDocxBlocks } from './docx.js';
import { extractPdfParagraphs } from './pdf.js';
import { SAMPLE_NAME, SAMPLE_TEXT, READING_SAMPLE_NAME, READING_SAMPLE_TEXT } from './sample.js';

const APP_VERSION = '1.1.1';
const STORE_KEY = 'reviewbuddy:v1';

const MODES = {
  draft: {
    name: 'Draft review',
    icon: '📝',
    marks: {
      green: { label: 'Approve / keep', short: 'Keep', glyph: '✓' },
      yellow: { label: 'Mixed / needs refinement', short: 'Refine', glyph: '~' },
      red: { label: 'Revise', short: 'Revise', glyph: '✗' },
    },
    defaultTool: 'green',
    submit: 'Submit',
  },
  read: {
    name: 'Document review',
    icon: '🔎',
    marks: {
      key: { label: 'Key point', short: 'Key point', glyph: '★' },
      research: { label: 'Research this', short: 'Research', glyph: '🔎' },
      explain: { label: 'Explain this to me', short: 'Explain', glyph: '?' },
    },
    defaultTool: 'key',
    submit: 'Ask Claude',
  },
};
const RATINGS = {
  like: { label: 'Like', glyph: '👍' },
  mixed: { label: 'Mixed', glyph: '〰️' },
  revise: { label: 'Revise', glyph: '✏️' },
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

// ---------------------------------------------------------------- storage

function emptyStore() {
  return { reviews: {}, currentId: null, tool: 'green', toolRead: 'key', showChanges: true, exportOpts: {} };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.reviews === 'object') return { ...emptyStore(), ...s };
    }
  } catch (e) {
    /* storage unavailable — fall through */
  }
  return emptyStore();
}

let store = loadStore();
let review = store.currentId ? store.reviews[store.currentId] || null : null;
let undoStack = [];
let saveTimer = null;

const modeOf = (rev) => (rev && rev.mode === 'read' ? 'read' : 'draft');
const M = () => MODES[modeOf(review)];

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (review) review.updatedAt = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    setStatus(`Saved on this device · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    return true;
  } catch (e) {
    setStatus('⚠ Not saved', true);
    toast('Could not save. Browser storage may be full, or Private Browsing may be on. Use the backup option to keep a copy.', 6000);
    return false;
  }
}

function saveSoon() {
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

const flush = () => { if (saveTimer) saveNow(); };
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const keyOf = (secId, p, s) => `${secId}|${p}|${s}`;
const parseKey = (k) => { const [secId, p, s] = k.split('|'); return { secId, p: +p, s: +s }; };
const pnum = (sec, p) => (sec.pStart || 0) + p + 1;
const shortLabel = (t, n = 40) => (t.length > n ? `${t.slice(0, n - 1).trim()}…` : t);

function sentenceId(rev, sec, p, s) {
  if (modeOf(rev) === 'read') {
    const where = sec.label === 'Document' ? '' : ` · ${shortLabel(sec.label)}`;
    return `¶${pnum(sec, p)} S${s + 1}${where}`;
  }
  return `${sec.label} ¶${p + 1} S${s + 1}`;
}

function setStatus(text, warn = false) {
  const el = $('#doc-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function openDialog(id) {
  const d = document.getElementById(id);
  if (!d.open) d.showModal();
  return d;
}

function closeLibrary() {
  const d = $('#dlg-library');
  if (d.open) d.close();
}

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  // tap on the dimmed backdrop closes a dialog
  if (e.target instanceof HTMLDialogElement && e.target.open) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
  }
});

// ---------------------------------------------------------------- review model

function createReview(name, blocks, mode) {
  const { structured, sections } = mode === 'read'
    ? buildReadingSections(blocks)
    : buildReviewSections(blocks.map((b) => (typeof b === 'string' ? b : b.text)));
  return {
    id: uid(),
    mode,
    docName: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    round: 1,
    parentId: null,
    structured,
    sections,
    marks: {},
    comments: {},
    notes: {},
    ratings: {},
    questions: '',
    carried: {},
    changes: {},
    requestChanged: {},
    prev: {},
  };
}

// Sections that count toward progress (draft mode skips the caption/signature sections).
const countsToward = (rev, sec) => modeOf(rev) === 'read' || !rev.structured || sec.kind === 'rfp';

function* sentences(rev, onlyMain = false) {
  for (const sec of rev.sections) {
    if (onlyMain && !countsToward(rev, sec)) continue;
    for (let p = 0; p < sec.paras.length; p++) {
      for (let s = 0; s < sec.paras[p].length; s++) yield { sec, p, s, text: sec.paras[p][s], key: keyOf(sec.id, p, s) };
    }
  }
}

function applyCarryOver(prev, next) {
  let carried = 0;
  let changed = 0;
  let unrevised = 0;
  for (const sec of next.sections) {
    const old = prev.sections.find((x) => x.id === sec.id);
    if (old) {
      if (sec.kind === 'rfp' && normalize(old.request.join(' ')) !== normalize(sec.request.join(' '))) next.requestChanged[sec.id] = true;
      if (prev.notes[sec.id] || prev.ratings[sec.id]) next.prev[sec.id] = { round: prev.round, notes: prev.notes[sec.id] || '', rating: prev.ratings[sec.id] || null };
    }
    const prior = new Map();
    if (old) {
      old.paras.forEach((para, p) => para.forEach((text, s) => {
        const n = normalize(text);
        if (!prior.has(n)) prior.set(n, prev.marks[keyOf(old.id, p, s)] || null);
      }));
    }
    sec.paras.forEach((para, p) => para.forEach((text, s) => {
      const k = keyOf(sec.id, p, s);
      const n = normalize(text);
      if (!prior.has(n)) {
        if (old || prev.sections.length) { next.changes[k] = 'new'; changed++; }
        return;
      }
      const color = prior.get(n);
      if (color === 'green') { next.marks[k] = 'green'; next.carried[k] = true; carried++; }
      else if (color === 'red' || color === 'yellow') { next.changes[k] = `unrevised-${color}`; unrevised++; }
    }));
  }
  return { carried, changed, unrevised };
}

// ---------------------------------------------------------------- loading documents

let pendingMode = 'draft';

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) await handleFile(file, pendingMode);
});

function pickFile(mode) {
  pendingMode = mode;
  closeLibrary();
  $('#file-input').click();
}

async function handleFile(file, mode) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'json') return importBackup(await file.text());
    let blocks;
    if (ext === 'docx') blocks = await extractDocxBlocks(await file.arrayBuffer());
    else if (ext === 'pdf' || file.type === 'application/pdf') {
      setStatus('Reading PDF…');
      blocks = await extractPdfParagraphs(await file.arrayBuffer());
    } else if (ext === 'txt' || ext === 'md' || file.type === 'text/plain') blocks = paragraphsFromText(await file.text());
    else if (ext === 'doc' || ext === 'pages' || ext === 'rtf') {
      throw new Error(`.${ext} files can't be read directly. Save it as Word (.docx) or PDF — in Pages: Share/Export → Word or PDF — or paste the text.`);
    } else throw new Error('Unsupported file. Use a PDF, Word (.docx) or plain-text (.txt) file, or paste the text.');
    return startReview(name, blocks, mode);
  } catch (err) {
    if (review) setStatus(`Saved on this device · ${fmtDate(review.updatedAt)}`);
    toast(err.message || String(err), 7000);
  }
}

function startReview(name, blocks, mode) {
  if (!blocks.length) { toast('No text found in that document.'); return; }
  const next = createReview(name, blocks, mode);
  if (!next.sections.length) { toast('No text found in that document.'); return; }
  const prior = Object.values(store.reviews).filter((r) => modeOf(r) === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
  if (mode === 'read' || !prior.length) return commitReview(next);

  const opts = $('#round-options');
  opts.replaceChildren(...prior.slice(0, 8).map((p) => h('button', {
    class: 'btn block', type: 'button',
    onclick: () => {
      $('#dlg-round').close();
      next.round = (p.round || 1) + 1;
      next.parentId = p.id;
      const r = applyCarryOver(p, next);
      commitReview(next);
      toast(`Round ${next.round}: kept ${r.carried} approved sentence${r.carried === 1 ? '' : 's'}; ${r.changed} new/changed; ${r.unrevised} flagged but unchanged.`, 6000);
    },
  }, `Yes — Round ${(p.round || 1) + 1} of “${p.docName}”`, h('small', {}, `Round ${p.round || 1} · last edited ${fmtDate(p.updatedAt)}`))));
  $('#btn-round-new').onclick = () => { $('#dlg-round').close(); commitReview(next); };
  openDialog('dlg-round');
}

function commitReview(next) {
  store.reviews[next.id] = next;
  store.currentId = next.id;
  review = next;
  undoStack = [];
  requestPersistence();
  saveNow();
  render();
  window.scrollTo(0, 0);
  if (modeOf(next) === 'draft' && !next.structured) toast('No “Request for Production No. …” headings were found, so the whole document is shown as one section.', 6000);
}

function importBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('That .json file is not a ReviewBuddy backup.'); }
  const rev = obj && obj.format === 'reviewbuddy-review' ? obj.review : null;
  if (!rev || !Array.isArray(rev.sections)) throw new Error('That .json file is not a ReviewBuddy backup.');
  for (const f of ['marks', 'comments', 'notes', 'ratings', 'carried', 'changes', 'requestChanged', 'prev']) rev[f] = rev[f] || {};
  if (store.reviews[rev.id] && !confirm(`Replace the saved copy of “${rev.docName}” with this backup?`)) return;
  rev.id = rev.id || uid();
  commitReview(rev);
  toast('Backup restored.');
}

// ---------------------------------------------------------------- rendering

function render() {
  const has = !!review;
  $('#btn-export').disabled = !has;
  $('#btn-export').textContent = has ? M().submit : 'Submit';
  $('#topbar-second').hidden = !has;
  document.body.classList.toggle('show-changes', !!store.showChanges);
  document.body.dataset.mode = has ? modeOf(review) : '';
  if (!has) {
    $('#doc-title').textContent = 'ReviewBuddy';
    setStatus('Private · works offline');
    main.replaceChildren(renderWelcome());
    updateUndo();
    return;
  }
  $('#doc-title').textContent = review.round > 1 ? `${review.docName} · Round ${review.round}` : review.docName;
  setStatus(`Saved on this device · ${fmtDate(review.updatedAt)}`);
  const frag = document.createDocumentFragment();
  if (review.round > 1) frag.append(renderRoundBanner());
  frag.append(renderLegend());
  for (const sec of review.sections) frag.append(renderSection(sec));
  const read = modeOf(review) === 'read';
  frag.append(h('div', { class: 'end-panel' },
    h('p', {}, 'End of document.'),
    h('div', { class: 'btn-row center' },
      h('button', { class: 'btn primary', type: 'button', onclick: openExport }, read ? 'Ask Claude about this' : 'Submit review'),
      h('button', { class: 'btn', type: 'button', onclick: () => pickFile(modeOf(review)) }, read ? 'Open another document…' : 'Load revised draft…'))));
  main.replaceChildren(frag);
  renderJump();
  updateProgress();
  updateUndo();
  for (const ta of main.querySelectorAll('textarea.notes')) if (ta.value) autosize(ta);
}

function renderModeCards() {
  const card = (mode, title, desc, openLabel) => h('div', { class: `mode-card ${mode}` },
    h('h2', {}, `${MODES[mode].icon} ${title}`),
    h('p', {}, desc),
    h('div', { class: 'btn-col' },
      h('button', { class: 'btn primary big', type: 'button', 'data-start': mode, onclick: () => pickFile(mode) }, openLabel),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => openPaste(mode) }, 'Paste text'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { closeLibrary(); startReview(mode === 'read' ? READING_SAMPLE_NAME : SAMPLE_NAME, paragraphsFromText(mode === 'read' ? READING_SAMPLE_TEXT : SAMPLE_TEXT), mode); } }, 'Try a sample'))));
  return h('div', { class: 'mode-cards' },
    card('draft', 'Review my draft',
      'For drafts you’re working on (like RFP responses). Mark each sentence keep / refine / revise, rate each section, and get revision instructions for the next round.',
      'Open draft…'),
    card('read', 'Review a document',
      'For reading someone else’s document (a case, brief, contract, article). Highlight key points, mark what to research or explain, add notes — then get a ready-made prompt for Claude.',
      'Open document…'));
}

function renderWelcome() {
  return h('div', { class: 'welcome' },
    h('h1', {}, 'ReviewBuddy'),
    h('p', { class: 'lede' }, 'Tap sentences to highlight them, add notes, and turn your review into a clear message for Claude. Everything stays on this device.'),
    renderModeCards(),
    h('p', { class: 'hint' }, 'Opens PDF, Word (.docx) and text files. You can also open a ReviewBuddy backup (.json) to restore a review.'),
    renderSavedList(),
    renderPrivacy());
}

function renderSavedList() {
  const list = Object.values(store.reviews).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return h('div');
  return h('div', { class: 'saved' },
    h('h3', {}, 'Saved on this device'),
    h('ul', { class: 'saved-list' }, list.map((r) => {
      const { marked, total } = counts(r);
      const mode = modeOf(r);
      const meta = mode === 'read' ? `Document review · ${marked} highlighted` : `Draft review · Round ${r.round || 1} · ${marked}/${total} marked`;
      return h('li', { class: r.id === store.currentId ? 'current' : '' },
        h('button', {
          class: 'saved-open', type: 'button',
          onclick: () => { store.currentId = r.id; review = r; undoStack = []; saveNow(); closeLibrary(); render(); window.scrollTo(0, 0); },
        }, h('strong', {}, `${MODES[mode].icon} ${r.docName}`), h('small', {}, `${meta} · ${fmtDate(r.updatedAt)}`)),
        h('button', {
          class: 'icon-btn danger', type: 'button', 'aria-label': `Delete ${r.docName}`,
          onclick: () => {
            if (!confirm(`Delete “${r.docName}” and all of its highlights and notes from this device?`)) return;
            delete store.reviews[r.id];
            if (store.currentId === r.id) { store.currentId = null; review = null; }
            saveNow();
            refreshLibrary();
            render();
          },
        }, '🗑'));
    })));
}

function renderPrivacy() {
  return h('details', { class: 'privacy' },
    h('summary', {}, '🔒 How your documents stay private'),
    h('ul', {},
      h('li', {}, 'Your document is read and processed only inside this browser. It is never uploaded.'),
      h('li', {}, 'The app is locked by a Content Security Policy that forbids any network connection, so it cannot send data anywhere even by accident.'),
      h('li', {}, 'No analytics, trackers, cookies, fonts, or outside code. The PDF reader (Mozilla pdf.js) is bundled inside the app.'),
      h('li', {}, 'Highlights and notes autosave to this browser’s local storage on this device only.'),
      h('li', {}, 'Safari may clear site data if you don’t open the app for several weeks, and data in a Home-Screen app is separate from Safari tabs. Save a .json backup for anything important.')));
}

function renderRoundBanner() {
  return h('div', { class: 'banner' },
    h('strong', {}, `Round ${review.round}. `),
    'Green approvals from the previous round were kept on unchanged sentences. ',
    h('span', { class: 'chg-sample new' }, 'Dashed outline'), ' = new or rewritten. ',
    h('span', { class: 'chg-sample unrev' }, '⟲'), ' = flagged last round but unchanged. ',
    h('label', { class: 'check inline' },
      h('input', { type: 'checkbox', checked: !!store.showChanges, onchange: (e) => { store.showChanges = e.target.checked; document.body.classList.toggle('show-changes', store.showChanges); saveNow(); } }),
      ' Show changes'));
}

function renderLegend() {
  const marks = M().marks;
  return h('div', { class: 'legend' },
    h('span', {}, 'Pick a tool beside any paragraph, then tap sentences:'),
    Object.entries(marks).map(([c, info]) => h('span', { class: `lg ${c}` }, `${info.glyph} ${info.short}`)),
    h('span', { class: 'lg' }, modeOf(review) === 'read' ? '✎ Note / question' : '✎ Comment'));
}

function currentTool() {
  const mode = modeOf(review);
  const t = mode === 'read' ? store.toolRead : store.tool;
  const valid = t === 'erase' || t === 'comment' || (t && MODES[mode].marks[t]);
  return valid ? t : MODES[mode].defaultTool;
}

function renderTools(sec, p) {
  const tool = currentTool();
  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': `Paragraph ${pnum(sec, p)} highlighter` },
    h('span', { class: 'pnum' }, `¶${pnum(sec, p)}`));
  for (const [c, info] of Object.entries(M().marks)) {
    tools.append(h('button', { class: `tool ${c}`, type: 'button', 'data-tool': c, 'aria-label': info.label, title: info.label, 'aria-pressed': String(tool === c) }, info.glyph));
  }
  const read = modeOf(review) === 'read';
  tools.append(
    h('button', { class: 'tool erase', type: 'button', 'data-tool': 'erase', 'aria-label': 'Clear highlight', title: 'Clear highlight', 'aria-pressed': String(tool === 'erase') }, '⌫'),
    h('button', { class: 'tool comment', type: 'button', 'data-tool': 'comment', 'aria-label': read ? 'Add a note or question to a sentence' : 'Add a comment to a sentence', title: read ? 'Note / question' : 'Comment on a sentence', 'aria-pressed': String(tool === 'comment') }, '✎'),
    h('button', { class: 'tool all', type: 'button', 'data-all': `${sec.id}|${p}`, title: 'Apply the selected tool to the whole paragraph' }, 'All'));
  return tools;
}

function sentenceClass(k) {
  const c = ['sent'];
  const m = review.marks[k];
  if (m) c.push(`m-${m}`);
  if (review.comments[k]) c.push('has-comment');
  if (review.carried[k]) c.push('carried');
  const ch = review.changes[k];
  if (ch === 'new') c.push('chg-new');
  else if (ch) c.push('chg-unrev');
  return c.join(' ');
}

function renderSection(sec) {
  const isRfp = sec.kind === 'rfp';
  const body = [];

  if (isRfp) {
    body.push(h('div', { class: 'request' },
      h('div', { class: 'label' }, 'Request'),
      review.requestChanged[sec.id] ? h('p', { class: 'warn-line' }, '⚠ This request’s wording differs from the previous round. Requests should stay unchanged.') : null,
      sec.request.length ? sec.request.map((t) => h('p', {}, t)) : h('p', { class: 'muted' }, '(No request text found.)')));
  }

  const resp = h('div', { class: 'response' }, isRfp ? h('div', { class: 'label' }, 'Response') : null);
  if (!sec.paras.length) resp.append(h('p', { class: 'muted' }, '(No response text found for this request.)'));
  sec.paras.forEach((para, p) => {
    const ptext = h('p', { class: 'para-text' });
    para.forEach((text, s) => {
      const k = keyOf(sec.id, p, s);
      if (s) ptext.append(' ');
      ptext.append(h('span', { class: sentenceClass(k), 'data-k': k, role: 'button', tabindex: '0' }, text));
    });
    resp.append(h('div', { class: 'para' }, renderTools(sec, p), ptext));
  });
  body.push(resp);
  body.push(renderReviewBox(sec));

  const head = h('header', { class: 'sec-head' },
    sec.kicker ? h('div', { class: 'kicker' }, sec.kicker) : null,
    h('h2', {}, sec.label),
    h('span', { class: 'sec-stats', id: `stats-${sec.id}` }));

  if (modeOf(review) === 'draft' && !isRfp && review.structured) {
    return h('details', { class: 'section other', id: `sec-${sec.id}` }, h('summary', {}, head), ...body);
  }
  return h('section', { class: `section ${isRfp ? 'rfp' : modeOf(review) === 'read' ? 'read' : 'other'}`, id: `sec-${sec.id}` }, head, ...body);
}

function renderReviewBox(sec) {
  const read = modeOf(review) === 'read';
  const box = h('div', { class: 'review-box' });
  if (!read) {
    const rating = review.ratings[sec.id] || null;
    const row = h('div', { class: 'rating-row', role: 'radiogroup', 'aria-label': `Overall rating for ${sec.label}` },
      h('span', { class: 'label' }, 'Overall'));
    for (const [r, info] of Object.entries(RATINGS)) {
      row.append(h('button', { class: `rate ${r}`, type: 'button', role: 'radio', 'data-rate': `${sec.id}|${r}`, 'aria-checked': String(rating === r) }, `${info.glyph} ${info.label}`));
    }
    box.append(row);
  } else {
    box.append(h('div', { class: 'label' }, 'Research notes'));
  }
  const ta = h('textarea', {
    class: 'notes', 'data-notes': sec.id, rows: '3',
    placeholder: read ? `Notes and questions about “${shortLabel(sec.label, 30)}”…` : `Notes on ${sec.label} (broader comments)…`,
    'aria-label': `Notes for ${sec.label}`,
  });
  ta.value = review.notes[sec.id] || '';
  box.append(ta);
  const prev = review.prev[sec.id];
  if (prev && (prev.notes || prev.rating)) {
    box.append(h('details', { class: 'prev-notes' },
      h('summary', {}, `Your Round ${prev.round} feedback${prev.rating ? ` (${RATINGS[prev.rating].label})` : ''}`),
      h('p', {}, prev.notes || '(no notes)')));
  }
  return box;
}

function renderJump() {
  const sel = $('#jump');
  const read = modeOf(review) === 'read';
  sel.replaceChildren(h('option', { value: '' }, 'Jump to…'), ...review.sections.map((sec) => {
    let dot;
    if (read) {
      const touched = counts(review, sec.id).marked || review.notes[sec.id] || sentencesOf(sec).some((x) => review.comments[x.key]);
      dot = touched ? '● ' : '○ ';
    } else {
      const r = review.ratings[sec.id];
      dot = r === 'like' ? '🟢 ' : r === 'mixed' ? '🟡 ' : r === 'revise' ? '🔴 ' : '⚪ ';
    }
    return h('option', { value: sec.id }, dot + shortLabel(sec.label, 48));
  }));
}

$('#jump').addEventListener('change', (e) => {
  const id = e.target.value;
  e.target.value = '';
  if (!id) return;
  const el = document.getElementById(`sec-${id}`);
  if (!el) return;
  if (el.tagName === 'DETAILS') el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function sentencesOf(sec) {
  const out = [];
  sec.paras.forEach((para, p) => para.forEach((text, s) => out.push({ p, s, text, key: keyOf(sec.id, p, s) })));
  return out;
}

function counts(rev, secId = null) {
  let total = 0;
  let marked = 0;
  let comments = 0;
  const by = {};
  for (const x of sentences(rev, secId == null)) {
    if (secId != null && x.sec.id !== secId) continue;
    total++;
    if (rev.comments[x.key]) comments++;
    const m = rev.marks[x.key];
    if (m) { marked++; by[m] = (by[m] || 0) + 1; }
  }
  return { total, marked, by, comments };
}

function updateSectionStats(secId) {
  const el = document.getElementById(`stats-${secId}`);
  if (!el) return;
  const { total, marked, by, comments } = counts(review, secId);
  const marks = M().marks;
  if (modeOf(review) === 'read') {
    el.replaceChildren(...[
      ...Object.entries(marks).map(([c, info]) => (by[c] ? h('span', { class: `pill ${c}` }, `${info.glyph}${by[c]}`) : null)),
      comments ? h('span', { class: 'pill' }, `💬${comments}`) : null].filter(Boolean));
    return;
  }
  const r = review.ratings[secId];
  el.replaceChildren(...[
    h('span', { class: 'count' }, `${marked}/${total}`),
    ...Object.entries(marks).map(([c, info]) => (by[c] ? h('span', { class: `pill ${c}` }, `${info.glyph}${by[c]}`) : null)),
    r ? h('span', { class: `pill rating ${r}` }, RATINGS[r].label) : null].filter(Boolean));
}

function updateProgress() {
  if (!review) return;
  for (const sec of review.sections) updateSectionStats(sec.id);
  const { total, marked, by, comments } = counts(review);
  if (modeOf(review) === 'read') {
    const notes = Object.values(review.notes).filter((v) => v && v.trim()).length + comments;
    $('#progress').textContent = `${marked} highlighted · ${(by.research || 0) + (by.explain || 0)} questions · ${notes} notes`;
    return;
  }
  const rfps = review.sections.filter((s) => countsToward(review, s));
  const rated = rfps.filter((s) => review.ratings[s.id]).length;
  $('#progress').textContent = `${marked}/${total} sentences · ${rated}/${rfps.length} rated`;
}

function refreshSentence(k) {
  const el = main.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (el) el.className = sentenceClass(k);
}

// ---------------------------------------------------------------- interactions

function setTool(tool) {
  if (modeOf(review) === 'read') store.toolRead = tool; else store.tool = tool;
  for (const b of main.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  saveSoon();
}

function setMarks(changes) {
  const undo = [];
  for (const { k, color } of changes) {
    const before = review.marks[k] || null;
    if (before === color) continue;
    undo.push({ k, color: before, carried: !!review.carried[k] });
    if (color) review.marks[k] = color; else delete review.marks[k];
    delete review.carried[k];
    refreshSentence(k);
  }
  if (!undo.length) return;
  undoStack.push(undo);
  if (undoStack.length > 200) undoStack.shift();
  updateUndo();
  updateProgress();
  renderJump();
  saveNow();
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  for (const { k, color, carried } of last) {
    if (color) review.marks[k] = color; else delete review.marks[k];
    if (carried) review.carried[k] = true;
    refreshSentence(k);
  }
  updateUndo();
  updateProgress();
  saveNow();
}

function updateUndo() {
  $('#btn-undo').disabled = !undoStack.length;
}

function onSentence(el) {
  const k = el.dataset.k;
  const tool = currentTool();
  if (tool === 'comment') return openComment(k);
  if (tool === 'erase') return setMarks([{ k, color: null }]);
  const cur = review.marks[k] || null;
  setMarks([{ k, color: cur === tool ? null : tool }]);
}

function onAll(spec) {
  const [secId, p] = spec.split('|');
  const sec = review.sections.find((s) => s.id === secId);
  if (!sec) return;
  const keys = sec.paras[+p].map((_, s) => keyOf(secId, +p, s));
  const tool = currentTool();
  let color = tool === 'erase' || tool === 'comment' ? null : tool;
  if (color && keys.every((k) => review.marks[k] === color)) color = null; // second tap clears
  setMarks(keys.map((k) => ({ k, color })));
}

main.addEventListener('click', (e) => {
  if (!review) return;
  const t = e.target;
  const tool = t.closest('.tool[data-tool]');
  if (tool) return setTool(tool.dataset.tool);
  const all = t.closest('[data-all]');
  if (all) return onAll(all.dataset.all);
  const rate = t.closest('[data-rate]');
  if (rate) {
    const [secId, r] = rate.dataset.rate.split('|');
    if (review.ratings[secId] === r) delete review.ratings[secId]; else review.ratings[secId] = r;
    for (const b of rate.parentElement.querySelectorAll('[data-rate]')) b.setAttribute('aria-checked', String(review.ratings[secId] === b.dataset.rate.split('|')[1]));
    updateProgress();
    renderJump();
    saveNow();
    return;
  }
  const sent = t.closest('.sent');
  if (sent) {
    // Don't hijack a tap that ends a deliberate text selection.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).length > 1) return;
    onSentence(sent);
  }
});

main.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('sent')) {
    e.preventDefault();
    onSentence(e.target);
  }
});

main.addEventListener('input', (e) => {
  const ta = e.target.closest('[data-notes]');
  if (!ta || !review) return;
  const v = ta.value;
  if (v.trim()) review.notes[ta.dataset.notes] = v; else delete review.notes[ta.dataset.notes];
  autosize(ta);
  updateProgress();
  saveSoon();
});

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 480)}px`;
}

$('#btn-undo').addEventListener('click', undo);
$('#btn-menu').addEventListener('click', () => { refreshLibrary(); openDialog('dlg-library'); });
$('#btn-export').addEventListener('click', openExport);

// ---------------------------------------------------------------- comments

let commentKey = null;
function openComment(k) {
  commentKey = k;
  const { secId, p, s } = parseKey(k);
  const sec = review.sections.find((x) => x.id === secId);
  const read = modeOf(review) === 'read';
  $('#comment-title').textContent = sentenceId(review, sec, p, s);
  $('#comment-sentence').textContent = sec.paras[p][s];
  $('#comment-text').value = review.comments[k] || '';
  $('#comment-text').placeholder = read ? 'Your note or question (e.g. “What does this term mean?”, “Is this still good law?”)' : 'What should change in this sentence?';
  $('#btn-comment-delete').hidden = !review.comments[k];
  openDialog('dlg-comment');
  setTimeout(() => $('#comment-text').focus(), 50);
}
$('#btn-comment-save').addEventListener('click', () => {
  const v = $('#comment-text').value.trim();
  if (v) review.comments[commentKey] = v; else delete review.comments[commentKey];
  refreshSentence(commentKey);
  updateProgress();
  renderJump();
  saveNow();
  $('#dlg-comment').close();
});
$('#btn-comment-delete').addEventListener('click', () => {
  delete review.comments[commentKey];
  refreshSentence(commentKey);
  updateProgress();
  saveNow();
  $('#dlg-comment').close();
});

// ---------------------------------------------------------------- paste

let pasteMode = 'draft';
function openPaste(mode) {
  pasteMode = mode;
  closeLibrary();
  $('#paste-title').textContent = mode === 'read' ? 'Paste a document to review' : 'Paste draft text';
  $('#paste-name').value = mode === 'read' ? 'Pasted document' : 'Pasted draft';
  $('#paste-text').placeholder = mode === 'read' ? 'Paste the document text here…' : 'Paste the full draft here (requests and responses)…';
  openDialog('dlg-paste');
}

$('#btn-paste-load').addEventListener('click', () => {
  const text = $('#paste-text').value;
  if (!text.trim()) { toast('Paste the text first.'); return; }
  const name = $('#paste-name').value.trim() || 'Pasted text';
  $('#dlg-paste').close();
  $('#paste-text').value = '';
  startReview(name, paragraphsFromText(text), pasteMode);
});

// ---------------------------------------------------------------- library dialog

function refreshLibrary() {
  const body = $('#library-body');
  body.replaceChildren(
    renderModeCards(),
    renderSavedList(),
    renderPrivacy(),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => {
          if (!confirm('Erase ALL documents, highlights and notes stored by ReviewBuddy on this device? This cannot be undone.')) return;
          try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
          store = emptyStore();
          review = null;
          undoStack = [];
          closeLibrary();
          render();
          toast('All ReviewBuddy data erased from this device.');
        },
      }, 'Erase all data on this device'),
      h('p', { class: 'hint' }, `ReviewBuddy ${APP_VERSION}`)));
}

// ---------------------------------------------------------------- export: draft mode

function buildFeedback(rev) {
  const out = [];
  for (const sec of rev.sections) {
    const items = [];
    sec.paras.forEach((para, p) => para.forEach((text, s) => {
      const k = keyOf(sec.id, p, s);
      items.push({ id: sentenceId(rev, sec, p, s), paragraph: pnum(sec, p), sentence: s + 1, mark: rev.marks[k] || null, color: rev.marks[k] || null, text, comment: rev.comments[k] || null, carriedFromPreviousRound: !!rev.carried[k], change: rev.changes[k] || null });
    }));
    out.push({ section: sec.id, kind: sec.kind, rfp: sec.number, label: sec.label, rating: rev.ratings[sec.id] || null, notes: rev.notes[sec.id] || '', requestChangedFromPreviousRound: !!rev.requestChanged[sec.id], sentences: items });
  }
  return out;
}

function groupByPara(items) {
  const byP = new Map();
  for (const it of items) {
    if (!byP.has(it.paragraph)) byP.set(it.paragraph, []);
    byP.get(it.paragraph).push(it.sentence);
  }
  return [...byP].map(([p, ss]) => `¶${p} ${ranges(ss)}`).join('; ');
}

const oneLine = (t) => t.replace(/\s*\n\s*/g, ' ');

function buildFeedbackText(rev, { greenText = false, instructions = true } = {}) {
  const fb = buildFeedback(rev);
  const L = [];
  const core = fb.filter((s) => rev.sections.find((x) => x.id === s.section && countsToward(rev, x)));
  const all = core.flatMap((s) => s.sentences);
  const n = (c) => all.filter((x) => x.mark === c).length;
  const nr = (r) => core.filter((s) => s.rating === r).length;

  L.push('REVIEW FEEDBACK');
  L.push(`Document: ${rev.docName}`);
  L.push(`Review round: ${rev.round || 1}`);
  L.push(`Submitted: ${new Date().toLocaleString()}`);
  L.push('');
  if (instructions) {
    L.push('INSTRUCTIONS FOR THE NEXT ROUND');
    L.push('- Keep every request exactly as written.');
    L.push('- Preserve GREEN (approved) sentences word-for-word unless a note below specifically requires a change.');
    L.push('- Revise RED sentences. Refine YELLOW sentences. Leave unmarked sentences unchanged unless a note says otherwise.');
    L.push('- Address each RFP-level note.');
    L.push('- Return the complete updated set (all requests and responses), keeping the same headings and paragraph structure.');
    L.push('');
  }
  L.push('SUMMARY');
  L.push(`Sections rated: ${core.length - nr(null)}/${core.length} · Like ${nr('like')} · Mixed ${nr('mixed')} · Revise ${nr('revise')}`);
  L.push(`Sentences: ${all.length} · Green ${n('green')} · Yellow ${n('yellow')} · Red ${n('red')} · Unmarked ${n(null)}`);

  for (const sec of fb) {
    const hasFeedback = sec.rating || sec.notes.trim() || sec.sentences.some((x) => x.mark || x.comment);
    if (sec.kind !== 'rfp' && rev.structured && !hasFeedback) continue;
    L.push('');
    L.push('========================================');
    L.push(`${sec.label.toUpperCase()} — Overall: ${sec.rating ? RATINGS[sec.rating].label.toUpperCase() : 'NOT RATED'}`);
    if (sec.requestChangedFromPreviousRound) L.push('⚠ The request text differs from the previous round — restore the original request wording.');
    L.push(`Notes: ${sec.notes.trim() ? sec.notes.trim().replace(/\n/g, '\n       ') : '(none)'}`);
    const list = (color, title) => {
      const xs = sec.sentences.filter((x) => x.mark === color);
      if (!xs.length) return;
      L.push('');
      L.push(`${title}:`);
      for (const x of xs) {
        L.push(`  [${x.id}] “${x.text}”`);
        if (x.comment) L.push(`      Comment: ${oneLine(x.comment)}`);
      }
    };
    list('red', 'RED — revise');
    list('yellow', 'YELLOW — needs refinement');
    const greens = sec.sentences.filter((x) => x.mark === 'green');
    if (greens.length) {
      L.push('');
      if (greenText) {
        L.push('GREEN — approved, keep verbatim:');
        for (const x of greens) {
          L.push(`  [${x.id}] “${x.text}”`);
          if (x.comment) L.push(`      Comment: ${oneLine(x.comment)}`);
        }
      } else {
        L.push(`GREEN — approved, keep verbatim: ${groupByPara(greens)}`);
        for (const x of greens.filter((g) => g.comment)) L.push(`  [${x.id}] Comment: ${oneLine(x.comment)}`);
      }
    }
    const unmarked = sec.sentences.filter((x) => !x.mark);
    if (unmarked.length) {
      L.push('');
      L.push(`UNMARKED: ${groupByPara(unmarked)}`);
      for (const x of unmarked.filter((u) => u.comment)) L.push(`  [${x.id}] “${x.text}”\n      Comment: ${oneLine(x.comment)}`);
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- export: document (reading) mode

function buildReadingPrompt(rev, { plain = true, keyPoints = true, fullText = false } = {}) {
  const items = [];
  for (const sec of rev.sections) {
    sec.paras.forEach((para, p) => para.forEach((text, s) => {
      const k = keyOf(sec.id, p, s);
      if (rev.marks[k] || rev.comments[k]) items.push({ id: sentenceId(rev, sec, p, s), text, mark: rev.marks[k] || null, comment: rev.comments[k] || null });
    }));
  }
  const of = (m) => items.filter((x) => x.mark === m);
  const explain = of('explain');
  const research = of('research');
  const key = of('key');
  const otherNotes = items.filter((x) => !x.mark && x.comment);
  const sectionNotes = rev.sections.filter((s) => (rev.notes[s.id] || '').trim());
  const questions = (rev.questions || '').trim();

  const L = [];
  L.push(`I'm reviewing a document and would like your help understanding it and researching some issues.`);
  L.push('');
  L.push(`DOCUMENT: ${rev.docName}`);
  L.push(fullText ? 'The full text is included at the end of this message.' : 'I will attach or paste the document. If you don’t have it, ask me for it before answering.');
  L.push('');
  L.push('HOW TO ANSWER');
  if (plain) {
    L.push('- Use plain, simple language: short sentences, no jargon. Define any legal or technical term the first time you use it.');
    L.push('- Where it helps, give a short, concrete example.');
  }
  L.push('- Go item by item, using my labels (like [¶4 S2]) as headings so I can match your answers to the document.');
  if (explain.length) L.push('- For each “Explain” item: say what the passage means, why it matters in this document, and anything I should watch out for.');
  if (research.length) L.push('- For each “Research” item: explain the issue, the rule or law that governs it, the key authorities with full citations, and how it applies here. Say clearly when you are unsure, and never make up a case or citation.');
  L.push('- Answer my notes and questions.');
  L.push('- Finish with a short summary of the most important takeaways and any follow-up questions I should consider.');

  if (questions) {
    L.push('');
    L.push('MY OVERALL QUESTIONS');
    L.push(questions);
  }
  const list = (title, xs) => {
    if (!xs.length) return;
    L.push('');
    L.push(title);
    xs.forEach((x, i) => {
      L.push(`${i + 1}. [${x.id}] “${x.text}”`);
      if (x.comment) L.push(`   My note: ${oneLine(x.comment)}`);
    });
  };
  list('EXPLAIN THIS TO ME (what does it mean?)', explain);
  list('RESEARCH THIS', research);
  if (keyPoints) list('KEY POINTS I HIGHLIGHTED (context — answer only if my note asks something)', key);
  else list('NOTES ON KEY POINTS', key.filter((x) => x.comment));
  list('OTHER NOTES AND QUESTIONS', otherNotes);
  if (sectionNotes.length) {
    L.push('');
    L.push('MY RESEARCH NOTES BY SECTION');
    for (const s of sectionNotes) L.push(`- ${s.label}: ${rev.notes[s.id].trim().replace(/\n/g, '\n  ')}`);
  }
  if (!questions && !items.length && !sectionNotes.length) {
    L.push('');
    L.push('(I haven’t marked anything yet — please give me a plain-language summary of the document: what it is, the main points, and what matters most.)');
  }
  if (fullText) {
    L.push('');
    L.push('========================================');
    L.push('FULL DOCUMENT TEXT (paragraph numbers match my labels)');
    for (const sec of rev.sections) {
      L.push('');
      if (sec.label !== 'Document') L.push(`## ${sec.label}`);
      sec.paras.forEach((para, p) => L.push(`[¶${pnum(sec, p)}] ${para.join(' ')}`));
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- export dialog

const EXPORT_OPTS = {
  draft: [
    { id: 'greenText', label: 'Include full text of approved (green) sentences', def: false },
    { id: 'instructions', label: 'Include instructions for the next round', def: true },
  ],
  read: [
    { id: 'plain', label: 'Ask for plain, simple explanations', def: true },
    { id: 'keyPoints', label: 'Include my highlighted key points', def: true },
    { id: 'fullText', label: 'Include the full document text (so Claude has it without an attachment)', def: false },
  ],
};

function optsFor(mode) {
  const saved = (store.exportOpts && store.exportOpts[mode]) || {};
  const o = {};
  for (const opt of EXPORT_OPTS[mode]) o[opt.id] = opt.id in saved ? saved[opt.id] : opt.def;
  return o;
}

function exportText() {
  const mode = modeOf(review);
  return mode === 'read' ? buildReadingPrompt(review, optsFor('read')) : buildFeedbackText(review, optsFor('draft'));
}

function refreshExportText() {
  $('#export-text').value = exportText();
}

function openExport() {
  if (!review) return;
  flush();
  const mode = modeOf(review);
  const read = mode === 'read';
  $('#export-title').textContent = read ? 'Ask Claude' : 'Submit review';
  $('#export-hint').textContent = read
    ? 'A ready-to-paste prompt built from your highlights and notes. Each item is labeled by paragraph (¶) and sentence (S).'
    : 'Structured feedback for every RFP, with each highlighted sentence identified by RFP, paragraph (¶) and sentence (S) number.';
  $('#questions-wrap').hidden = !read;
  $('#export-questions').value = review.questions || '';
  const opts = optsFor(mode);
  $('#export-options').replaceChildren(...EXPORT_OPTS[mode].map((opt) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox', 'data-opt': opt.id, checked: !!opts[opt.id],
      onchange: (e) => {
        store.exportOpts = store.exportOpts || {};
        store.exportOpts[mode] = { ...optsFor(mode), [opt.id]: e.target.checked };
        saveSoon();
        refreshExportText();
      },
    }), ` ${opt.label}`)));
  $('#btn-copy').textContent = read ? 'Copy prompt' : 'Copy feedback';
  refreshExportText();
  $('#btn-share').hidden = !navigator.share;
  openDialog('dlg-export');
}

$('#export-questions').addEventListener('input', (e) => {
  if (!review) return;
  review.questions = e.target.value;
  saveSoon();
  refreshExportText();
});

function fileBase() {
  const safe = review.docName.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'review';
  return modeOf(review) === 'read' ? safe : `${safe}_round${review.round || 1}`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('#btn-copy').addEventListener('click', async () => {
  const text = $('#export-text').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = $('#export-text');
    ta.removeAttribute('readonly');
    ta.select();
    document.execCommand('copy');
    ta.setAttribute('readonly', '');
  }
  toast(modeOf(review) === 'read' ? 'Prompt copied — paste it into Claude.' : 'Feedback copied — paste it into your chat.');
});
$('#btn-share').addEventListener('click', async () => {
  try { await navigator.share({ title: `${modeOf(review) === 'read' ? 'Questions' : 'Review feedback'} – ${review.docName}`, text: $('#export-text').value }); } catch (e) { /* cancelled */ }
});
$('#btn-save-txt').addEventListener('click', () => download(`${fileBase()}_${modeOf(review) === 'read' ? 'prompt' : 'feedback'}.txt`, $('#export-text').value, 'text/plain'));
$('#btn-save-json').addEventListener('click', () => {
  const payload = { format: 'reviewbuddy-review', version: 2, mode: modeOf(review), exportedAt: new Date().toISOString(), feedback: buildFeedback(review), review };
  download(`${fileBase()}_backup.json`, JSON.stringify(payload, null, 2), 'application/json');
});

// ---------------------------------------------------------------- boot

render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Expose a tiny hook for automated tests only (no data leaves the page).
window.__reviewbuddy = { exportText: () => review && exportText(), store: () => store };
