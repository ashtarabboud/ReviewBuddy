// ReviewBuddy — private, on-device editorial review of RFP responses.
// All data lives in this browser's localStorage. There are no network calls,
// no analytics, and no third-party code. See README.md for the privacy design.

import { buildReviewSections, paragraphsFromText, normalize, ranges } from './parse.js';
import { extractDocxParagraphs } from './docx.js';
import { SAMPLE_NAME, SAMPLE_TEXT } from './sample.js';

const APP_VERSION = '1.0.0';
const STORE_KEY = 'reviewbuddy:v1';
const COLORS = {
  green: { label: 'Approve / keep', short: 'Green', glyph: '✓' },
  yellow: { label: 'Mixed / needs refinement', short: 'Yellow', glyph: '~' },
  red: { label: 'Revise', short: 'Red', glyph: '✗' },
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
  return { reviews: {}, currentId: null, tool: 'green', showChanges: true };
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
    toast('Could not save. Browser storage may be full, or Private Browsing may be on. Use Submit → Save backup to keep a copy.', 6000);
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

function createReview(name, paragraphs) {
  const { structured, sections } = buildReviewSections(paragraphs);
  return {
    id: uid(),
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
    carried: {},
    changes: {},
    requestChanged: {},
    prev: {},
  };
}

function* sentences(rev, onlyRfp = false) {
  for (const sec of rev.sections) {
    if (onlyRfp && rev.structured && sec.kind !== 'rfp') continue;
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

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) await handleFile(file);
});

function pickFile() {
  $('#file-input').click();
}

async function handleFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'docx') {
      const paras = await extractDocxParagraphs(await file.arrayBuffer());
      return startReview(name, paras);
    }
    if (ext === 'txt' || ext === 'md' || file.type === 'text/plain') {
      return startReview(name, paragraphsFromText(await file.text()));
    }
    if (ext === 'json') return importBackup(await file.text());
    if (ext === 'pdf' || ext === 'doc' || ext === 'pages' || ext === 'rtf') {
      throw new Error(`.${ext} files can't be read directly. Save the draft as Word (.docx) — in Pages: Share/Export → Word — or paste the text.`);
    }
    throw new Error('Unsupported file. Use a Word (.docx) or plain-text (.txt) file, or paste the text.');
  } catch (err) {
    toast(err.message || String(err), 7000);
  }
}

function startReview(name, paragraphs) {
  if (!paragraphs.length) { toast('No text found in that document.'); return; }
  const next = createReview(name, paragraphs);
  const prior = Object.values(store.reviews).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!prior.length) return commitReview(next);

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
  if (!next.structured) toast('No “Request for Production No. …” headings were found, so the whole document is shown as one section.', 6000);
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
  $('#topbar-second').hidden = !has;
  document.body.classList.toggle('show-changes', !!store.showChanges);
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
  frag.append(h('div', { class: 'end-panel' },
    h('p', {}, 'End of document.'),
    h('div', { class: 'btn-row center' },
      h('button', { class: 'btn primary', type: 'button', onclick: openExport }, 'Submit review'),
      h('button', { class: 'btn', type: 'button', onclick: pickFile }, 'Load revised draft…'))));
  main.replaceChildren(frag);
  renderJump();
  updateProgress();
  updateUndo();
}

function renderWelcome() {
  return h('div', { class: 'welcome' },
    h('h1', {}, 'Review drafts, privately.'),
    h('p', {}, 'Open a draft of RFP responses from your phone. Tap sentences to mark them green, yellow, or red, add notes and a rating for each RFP, then submit structured feedback.'),
    renderLoadButtons(),
    renderSavedList(),
    renderPrivacy());
}

function renderLoadButtons() {
  return h('div', { class: 'btn-col' },
    h('button', { class: 'btn primary big', type: 'button', onclick: () => { $('#dlg-library').close(); pickFile(); } }, 'Open draft (.docx or .txt)…'),
    h('button', { class: 'btn', type: 'button', onclick: () => { $('#dlg-library').close(); openDialog('dlg-paste'); } }, 'Paste text instead'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { $('#dlg-library').close(); startReview(SAMPLE_NAME, paragraphsFromText(SAMPLE_TEXT)); } }, 'Try a fictional sample'),
    h('p', { class: 'hint' }, 'You can also open a ReviewBuddy backup (.json) to restore a review.'));
}

function renderSavedList() {
  const list = Object.values(store.reviews).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return h('div');
  return h('div', { class: 'saved' },
    h('h3', {}, 'Saved on this device'),
    h('ul', { class: 'saved-list' }, list.map((r) => {
      const { marked, total } = counts(r);
      return h('li', { class: r.id === store.currentId ? 'current' : '' },
        h('button', {
          class: 'saved-open', type: 'button',
          onclick: () => { store.currentId = r.id; review = r; undoStack = []; saveNow(); $('#dlg-library').close(); render(); window.scrollTo(0, 0); },
        }, h('strong', {}, r.docName), h('small', {}, `Round ${r.round || 1} · ${marked}/${total} marked · ${fmtDate(r.updatedAt)}`)),
        h('button', {
          class: 'icon-btn danger', type: 'button', 'aria-label': `Delete ${r.docName}`,
          onclick: () => {
            if (!confirm(`Delete “${r.docName}” (round ${r.round || 1}) and all of its highlights and notes from this device?`)) return;
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
      h('li', {}, 'No analytics, trackers, cookies, fonts, or third-party code.'),
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
  return h('div', { class: 'legend' },
    h('span', {}, 'Pick a color beside any paragraph, then tap sentences:'),
    h('span', { class: 'lg green' }, '✓ Keep'),
    h('span', { class: 'lg yellow' }, '~ Refine'),
    h('span', { class: 'lg red' }, '✗ Revise'),
    h('span', { class: 'lg' }, '✎ Comment'));
}

function renderTools(secId, p) {
  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': `Paragraph ${p + 1} highlighter` },
    h('span', { class: 'pnum' }, `¶${p + 1}`));
  for (const [c, info] of Object.entries(COLORS)) {
    tools.append(h('button', { class: `tool ${c}`, type: 'button', 'data-tool': c, 'aria-label': info.label, title: info.label, 'aria-pressed': String(store.tool === c) }, info.glyph));
  }
  tools.append(
    h('button', { class: 'tool erase', type: 'button', 'data-tool': 'erase', 'aria-label': 'Clear highlight', title: 'Clear highlight', 'aria-pressed': String(store.tool === 'erase') }, '⌫'),
    h('button', { class: 'tool comment', type: 'button', 'data-tool': 'comment', 'aria-label': 'Add a comment to a sentence', title: 'Comment on a sentence', 'aria-pressed': String(store.tool === 'comment') }, '✎'),
    h('button', { class: 'tool all', type: 'button', 'data-all': `${secId}|${p}`, title: 'Apply the selected color to the whole paragraph' }, 'All'));
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
    resp.append(h('div', { class: 'para' }, renderTools(sec.id, p), ptext));
  });
  body.push(resp);
  body.push(renderReviewBox(sec));

  const head = h('header', { class: 'sec-head' },
    h('h2', {}, sec.label),
    h('span', { class: 'sec-stats', id: `stats-${sec.id}` }));

  if (!isRfp && review.structured) {
    const d = h('details', { class: 'section other', id: `sec-${sec.id}` },
      h('summary', {}, head),
      ...body);
    return d;
  }
  return h('section', { class: `section ${isRfp ? 'rfp' : 'other'}`, id: `sec-${sec.id}` }, head, ...body);
}

function renderReviewBox(sec) {
  const rating = review.ratings[sec.id] || null;
  const box = h('div', { class: 'review-box' });
  const row = h('div', { class: 'rating-row', role: 'radiogroup', 'aria-label': `Overall rating for ${sec.label}` },
    h('span', { class: 'label' }, 'Overall'));
  for (const [r, info] of Object.entries(RATINGS)) {
    row.append(h('button', { class: `rate ${r}`, type: 'button', role: 'radio', 'data-rate': `${sec.id}|${r}`, 'aria-checked': String(rating === r) }, `${info.glyph} ${info.label}`));
  }
  box.append(row);
  const ta = h('textarea', { class: 'notes', 'data-notes': sec.id, rows: '3', placeholder: `Notes on ${sec.label} (broader comments)…`, 'aria-label': `Notes for ${sec.label}` });
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
  sel.replaceChildren(h('option', { value: '' }, 'Jump to…'), ...review.sections.map((sec) => {
    const r = review.ratings[sec.id];
    const dot = r === 'like' ? '🟢 ' : r === 'mixed' ? '🟡 ' : r === 'revise' ? '🔴 ' : '⚪ ';
    return h('option', { value: sec.id }, dot + sec.label);
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

function counts(rev, secId = null) {
  let total = 0;
  let marked = 0;
  const by = { green: 0, yellow: 0, red: 0 };
  for (const x of sentences(rev, secId == null)) {
    if (secId != null && x.sec.id !== secId) continue;
    total++;
    const m = rev.marks[x.key];
    if (m) { marked++; by[m]++; }
  }
  return { total, marked, by };
}

function updateSectionStats(secId) {
  const el = document.getElementById(`stats-${secId}`);
  if (!el) return;
  const { total, marked, by } = counts(review, secId);
  const r = review.ratings[secId];
  el.replaceChildren(
    h('span', { class: 'count' }, `${marked}/${total}`),
    by.green ? h('span', { class: 'pill green' }, `✓${by.green}`) : null,
    by.yellow ? h('span', { class: 'pill yellow' }, `~${by.yellow}`) : null,
    by.red ? h('span', { class: 'pill red' }, `✗${by.red}`) : null,
    r ? h('span', { class: `pill rating ${r}` }, RATINGS[r].label) : null);
}

function updateProgress() {
  if (!review) return;
  for (const sec of review.sections) updateSectionStats(sec.id);
  const { total, marked } = counts(review);
  const rfps = review.sections.filter((s) => !review.structured || s.kind === 'rfp');
  const rated = rfps.filter((s) => review.ratings[s.id]).length;
  $('#progress').textContent = `${marked}/${total} sentences · ${rated}/${rfps.length} rated`;
}

function refreshSentence(k) {
  const el = main.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (el) el.className = sentenceClass(k);
}

// ---------------------------------------------------------------- interactions

function setTool(tool) {
  store.tool = tool;
  for (const b of main.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  saveSoon();
}

function setMarks(changes) {
  // changes: [{k, color|null}]
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
  const tool = store.tool;
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
  let color = store.tool === 'erase' || store.tool === 'comment' ? null : store.tool;
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
  $('#comment-title').textContent = `${sec.label} · ¶${p + 1} · S${s + 1}`;
  $('#comment-sentence').textContent = sec.paras[p][s];
  $('#comment-text').value = review.comments[k] || '';
  $('#btn-comment-delete').hidden = !review.comments[k];
  openDialog('dlg-comment');
  setTimeout(() => $('#comment-text').focus(), 50);
}
$('#btn-comment-save').addEventListener('click', () => {
  const v = $('#comment-text').value.trim();
  if (v) review.comments[commentKey] = v; else delete review.comments[commentKey];
  refreshSentence(commentKey);
  saveNow();
  $('#dlg-comment').close();
});
$('#btn-comment-delete').addEventListener('click', () => {
  delete review.comments[commentKey];
  refreshSentence(commentKey);
  saveNow();
  $('#dlg-comment').close();
});

// ---------------------------------------------------------------- paste

$('#btn-paste-load').addEventListener('click', () => {
  const text = $('#paste-text').value;
  if (!text.trim()) { toast('Paste the draft text first.'); return; }
  const name = $('#paste-name').value.trim() || 'Pasted draft';
  $('#dlg-paste').close();
  $('#paste-text').value = '';
  startReview(name, paragraphsFromText(text));
});

// ---------------------------------------------------------------- library dialog

function refreshLibrary() {
  const body = $('#library-body');
  body.replaceChildren(
    renderLoadButtons(),
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
          $('#dlg-library').close();
          render();
          toast('All ReviewBuddy data erased from this device.');
        },
      }, 'Erase all data on this device'),
      h('p', { class: 'hint' }, `ReviewBuddy ${APP_VERSION}`)));
}

// ---------------------------------------------------------------- export / submit

function buildFeedback(rev) {
  const out = [];
  for (const sec of rev.sections) {
    const items = [];
    sec.paras.forEach((para, p) => para.forEach((text, s) => {
      const k = keyOf(sec.id, p, s);
      items.push({ id: `${sec.label} ¶${p + 1} S${s + 1}`, paragraph: p + 1, sentence: s + 1, color: rev.marks[k] || null, text, comment: rev.comments[k] || null, carriedFromPreviousRound: !!rev.carried[k], change: rev.changes[k] || null });
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

function buildFeedbackText(rev, { greenText = false, instructions = true } = {}) {
  const fb = buildFeedback(rev);
  const L = [];
  const all = fb.flatMap((s) => (rev.structured && s.kind !== 'rfp' ? [] : s.sentences));
  const n = (c) => all.filter((x) => x.color === c).length;
  const rfps = fb.filter((s) => !rev.structured || s.kind === 'rfp');
  const nr = (r) => rfps.filter((s) => s.rating === r).length;

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
  L.push(`Sections rated: ${rfps.length - nr(null)}/${rfps.length} · Like ${nr('like')} · Mixed ${nr('mixed')} · Revise ${nr('revise')}`);
  L.push(`Sentences: ${all.length} · Green ${n('green')} · Yellow ${n('yellow')} · Red ${n('red')} · Unmarked ${n(null)}`);

  for (const sec of fb) {
    const hasFeedback = sec.rating || sec.notes.trim() || sec.sentences.some((x) => x.color || x.comment);
    if (sec.kind !== 'rfp' && rev.structured && !hasFeedback) continue;
    L.push('');
    L.push('========================================');
    L.push(`${sec.label.toUpperCase()} — Overall: ${sec.rating ? RATINGS[sec.rating].label.toUpperCase() : 'NOT RATED'}`);
    if (sec.requestChangedFromPreviousRound) L.push('⚠ The request text differs from the previous round — restore the original request wording.');
    L.push(`Notes: ${sec.notes.trim() ? sec.notes.trim().replace(/\n/g, '\n       ') : '(none)'}`);
    const list = (color, title) => {
      const xs = sec.sentences.filter((x) => x.color === color);
      if (!xs.length) return;
      L.push('');
      L.push(`${title}:`);
      for (const x of xs) {
        L.push(`  [${x.id}] “${x.text}”`);
        if (x.comment) L.push(`      Comment: ${x.comment.replace(/\n/g, ' ')}`);
      }
    };
    list('red', 'RED — revise');
    list('yellow', 'YELLOW — needs refinement');
    const greens = sec.sentences.filter((x) => x.color === 'green');
    if (greens.length) {
      L.push('');
      if (greenText) {
        L.push('GREEN — approved, keep verbatim:');
        for (const x of greens) {
          L.push(`  [${x.id}] “${x.text}”`);
          if (x.comment) L.push(`      Comment: ${x.comment.replace(/\n/g, ' ')}`);
        }
      } else {
        L.push(`GREEN — approved, keep verbatim: ${groupByPara(greens)}`);
        for (const x of greens.filter((g) => g.comment)) L.push(`  [${x.id}] Comment: ${x.comment.replace(/\n/g, ' ')}`);
      }
    }
    const unmarked = sec.sentences.filter((x) => !x.color);
    if (unmarked.length) {
      L.push('');
      L.push(`UNMARKED: ${groupByPara(unmarked)}`);
      for (const x of unmarked.filter((u) => u.comment)) L.push(`  [${x.id}] “${x.text}”\n      Comment: ${x.comment.replace(/\n/g, ' ')}`);
    }
  }
  return L.join('\n');
}

function refreshExportText() {
  $('#export-text').value = buildFeedbackText(review, { greenText: $('#opt-green-text').checked, instructions: $('#opt-instructions').checked });
}

function openExport() {
  if (!review) return;
  flush();
  refreshExportText();
  $('#btn-share').hidden = !navigator.share;
  openDialog('dlg-export');
}
$('#opt-green-text').addEventListener('change', refreshExportText);
$('#opt-instructions').addEventListener('change', refreshExportText);

function fileBase() {
  const safe = review.docName.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'review';
  return `${safe}_round${review.round || 1}`;
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
  toast('Feedback copied — paste it into your chat.');
});
$('#btn-share').addEventListener('click', async () => {
  try { await navigator.share({ title: `Review feedback – ${review.docName}`, text: $('#export-text').value }); } catch (e) { /* cancelled */ }
});
$('#btn-save-txt').addEventListener('click', () => download(`${fileBase()}_feedback.txt`, $('#export-text').value, 'text/plain'));
$('#btn-save-json').addEventListener('click', () => {
  const payload = { format: 'reviewbuddy-review', version: 1, exportedAt: new Date().toISOString(), feedback: buildFeedback(review), review };
  download(`${fileBase()}_backup.json`, JSON.stringify(payload, null, 2), 'application/json');
});

// ---------------------------------------------------------------- boot

render();
for (const ta of main.querySelectorAll('textarea.notes')) if (ta.value) autosize(ta);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Expose a tiny hook for automated tests only (no data leaves the page).
window.__reviewbuddy = { buildFeedbackText: () => review && buildFeedbackText(review), store: () => store };
