# ReviewBuddy

A private, on-device review tool for iPhone and iPad with two modes:

- **📝 Review my draft** — sentence-by-sentence review of your own drafts (e.g. responses to Requests for
  Production): keep / refine / revise, section ratings, and revision instructions for the next round.
- **🔎 Review a document** — read someone else's document (a case, brief, contract, article): highlight
  ★ key points, mark 🔎 research this and ? explain this, add notes and questions, then tap **Ask Claude** for a
  ready-to-paste prompt that asks for plain-language explanations and research (with real citations).

Opens PDF, Word (.docx) and plain-text files, or pasted text.

**GitHub hosts only the app's code. Your documents, highlights and notes never leave your device.**

## Document review mode

- Sections come from the document's headings (Word heading styles, or lines like `I. BACKGROUND`, `A. Privilege`);
  headings stacked above a section (a court caption, "III. DISCUSSION") appear as a small line above its title.
  Long documents without headings are split into parts of 12 paragraphs. Paragraph numbers run through the whole document.
- Tools beside each paragraph: ★ key point, 🔎 research this, ? explain this, ⌫ clear, ✎ note/question, All.
- A "Research notes" box under each section, and an "overall questions" box in the Ask Claude sheet.
- **Ask Claude** builds a prompt grouped into *Explain this*, *Research this*, *Key points*, and notes, each item labeled
  like `[¶4 S2 · B. Privilege]`. Options: plain, simple explanations (on), include key points (on), include the full
  document text (off — turn it on if you won't attach the document).
- PDFs are read with Mozilla's pdf.js, bundled in `vendor/pdfjs/` (Apache-2.0) — not loaded from a CDN. The app rebuilds
  paragraphs from the PDF's lines and drops running headers and page numbers. Scanned PDFs without selectable text can't be read.

## Draft review mode

- **Load a draft from your phone** — Word (`.docx`), PDF, or plain text (`.txt`), or paste the text.
- **Finds every RFP automatically** — headings like `REQUEST FOR PRODUCTION NO. 1:` /
  `RESPONSE TO REQUEST FOR PRODUCTION NO. 1:`, `Request No. 2:` / `Response:`, `DEMAND FOR PRODUCTION NO. 3`, etc.
- **Request shown in full, read-only.** Only the response is annotatable.
- **Response keeps its paragraphs**, and each sentence is individually tappable
  (legal citations such as `Fed. R. Civ. P. 34(b)(2)(C)` or `Smith v. Jones, 123 F.3d 456 (9th Cir. 2001)` stay in one sentence).
- **Color selector beside every paragraph:** ✓ green (approve / keep), ~ yellow (mixed / needs refinement),
  ✗ red (revise), ⌫ clear, ✎ sentence comment, and **All** to mark the whole paragraph. Tap a sentence twice to clear it. ↶ undoes.
- **Per-RFP overall rating** (Like / Mixed / Revise) and **one notes box per RFP**.
- **All RFPs on one scrolling page**, with a "Jump to…" menu and progress counts.
- **Autosave** to the browser on every tap/keystroke.
- **Submit** compiles everything into structured feedback — each item identified by RFP, paragraph and
  sentence (e.g. `[RFP No. 4 ¶2 S3]`) — with Copy, Share, Save `.txt`, and Save backup `.json`.
- **Later rounds:** load the revised draft and choose "Round 2 of …". Green approvals carry over to sentences
  whose text is unchanged; new/rewritten sentences get a dashed outline; sentences you flagged that were *not*
  changed get a ⟲ marker; your previous notes appear under each RFP; and a warning shows if any request's wording changed.

Text before the first request (caption, general objections) and after the last response (signature, verification)
appears in collapsed sections so it doesn't clutter the review but can still be marked.

## Privacy design

- All parsing happens in the browser. `.docx` files are unzipped with the browser's built-in `DecompressionStream`
  and read with `DOMParser`; PDFs are read by the bundled pdf.js — no upload, no CDN.
- `index.html` sets a strict **Content-Security-Policy** (`connect-src 'none'`, `default-src 'none'`, scripts and styles
  only from the app itself). Even if code tried to send data, the browser would block it.
- No analytics, trackers, cookies, web fonts or CDNs. The only third-party code is pdf.js, served from this app's own files.
- Data is stored only in this browser's `localStorage` on your device. "☰ → Erase all data on this device" deletes it.
- The service worker (`sw.js`) caches only the app's own files so it works offline; it never sees your documents.
- The automated tests prove this: they record every network request while a document is loaded, reviewed and
  exported (only the app's own files may load, and nothing after the document opens), and they deliberately try to
  `fetch`, `sendBeacon`, and load an image to an outside server — which must receive zero hits.

Things to know on iPhone:
- Safari can clear a website's stored data if you don't open it for several weeks. Use **Submit → Save backup (.json)**
  for anything you need to keep; open the `.json` file in ReviewBuddy to restore it.
- If you "Add to Home Screen", that copy has its **own separate storage** from Safari tabs. Pick one and stick with it.
- Private Browsing tabs don't keep data after they close.
- Copying or sharing the feedback sends it to whichever app you paste/share into; ReviewBuddy itself sends nothing.

## Hosting on GitHub Pages

1. Merge this into `main`.
2. In the repository on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
3. After a minute the app is at `https://<your-username>.github.io/reviewbuddy/`. Open that in Safari on your iPhone.

Notes: Pages for a *private* repository requires a paid GitHub plan; on a free plan the repository must be public.
That's fine for this app because the repository contains only code and fictional test data — **never commit real
documents or backups** (the `.gitignore` blocks `.docx` and backup files as a safety net).

## Using it

1. Open the app → **Open draft (.docx or .txt)…** → pick the draft from Files/iCloud Drive.
   (Pages files: export to Word or PDF first.)
2. Tap a color beside a paragraph, then tap sentences. Add a rating and notes for each RFP.
3. **Submit** → **Copy feedback** (or Share) → paste into your chat with the drafting assistant.
4. When the revised draft comes back, tap **Load revised draft…** at the bottom (or ☰ → Open draft) and choose
   **Round 2 of …**.

## Development

No build step — it's plain HTML/CSS/JavaScript modules.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # unit tests + browser tests (needs Playwright with Chromium)
npm run fixtures              # regenerate the fictional .docx/.pdf test fixtures (needs python-docx + Playwright)
```

Files: `index.html` (page + CSP), `js/app.js` (UI, storage, export), `js/parse.js` (sentence splitting and RFP detection),
`js/docx.js` (Word reader), `js/pdf.js` (PDF reader wrapper), `vendor/pdfjs/` (bundled pdf.js), `js/sample.js` (fictional sample), `sw.js` (offline cache), `tests/` (tests + fictional fixtures).
