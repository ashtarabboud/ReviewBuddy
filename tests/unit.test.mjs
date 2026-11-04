import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, detectSections, buildReviewSections, paragraphsFromText, ranges } from '../js/parse.js';
import { SAMPLE_TEXT } from '../js/sample.js';

test('sentence splitter keeps legal citations together', () => {
  assert.deepEqual(splitSentences('Plaintiff objects under Fed. R. Civ. P. 34(b)(2)(C). See Cal. Code Civ. Proc. § 2031.030. Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).'), [
    'Plaintiff objects under Fed. R. Civ. P. 34(b)(2)(C).',
    'See Cal. Code Civ. Proc. § 2031.030.',
    'Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).',
  ]);
  assert.deepEqual(splitSentences('Produce documents, e.g., emails and i.e. texts. The U.S. Supreme Court agreed. Id. at 5.'), [
    'Produce documents, e.g., emails and i.e. texts.',
    'The U.S. Supreme Court agreed.',
    'Id. at 5.',
  ]);
  assert.deepEqual(splitSentences('He said "no." Then it ended! Why? Because.'), ['He said "no."', 'Then it ended!', 'Why?', 'Because.']);
  assert.deepEqual(splitSentences('1. All documents. 2. All emails.'), ['1. All documents.', '2. All emails.']);
  assert.deepEqual(splitSentences('See Request No. 5. Plaintiff objects.'), ['See Request No. 5.', 'Plaintiff objects.']);
});

test('detects RFP headings in common formats', () => {
  const { structured, sections } = detectSections([
    'Caption text',
    'REQUEST FOR PRODUCTION NO. 1:',
    'Req one.',
    'RESPONSE TO REQUEST FOR PRODUCTION NO. 1:',
    'Resp one.',
    'Plaintiff will comply with Request No. 1 as stated.',
    'Request No. 2: Req two inline.',
    'Response: Resp two inline.',
    'DEMAND FOR PRODUCTION NO. 3',
    'Req three.',
    'SUPPLEMENTAL RESPONSE TO DEMAND FOR PRODUCTION NO. 3: Resp three.',
    'Response to Request No. 3 is above.',
    'Dated: today',
  ]);
  assert.equal(structured, true);
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids, ['pre', 'rfp-1', 'rfp-2', 'rfp-3', 'post']);
  assert.deepEqual(sections[1].request, ['Req one.']);
  assert.deepEqual(sections[1].response, ['Resp one.', 'Plaintiff will comply with Request No. 1 as stated.']);
  assert.deepEqual(sections[2].request, ['Req two inline.']);
  assert.deepEqual(sections[2].response, ['Resp two inline.']);
  assert.deepEqual(sections[3].response, ['Resp three.', 'Response to Request No. 3 is above.']);
  assert.deepEqual(sections[4].response, ['Dated: today']);
});

test('falls back to one section when no headings exist', () => {
  const r = buildReviewSections(['Just a memo.', 'Second paragraph. Two sentences.']);
  assert.equal(r.structured, false);
  assert.equal(r.sections.length, 1);
  assert.deepEqual(r.sections[0].paras, [['Just a memo.'], ['Second paragraph.', 'Two sentences.']]);
});

test('sample document parses into 3 RFPs', () => {
  const r = buildReviewSections(paragraphsFromText(SAMPLE_TEXT));
  assert.deepEqual(r.sections.filter((s) => s.kind === 'rfp').map((s) => s.number), ['1', '2', '3']);
});

test('hard-wrapped plain text is re-joined', () => {
  const t = 'REQUEST NO. 1:\nAll documents relating to\nthe contract.\n\nRESPONSE TO REQUEST NO. 1:\nPlaintiff will produce\nthem.';
  assert.deepEqual(paragraphsFromText(t), ['REQUEST NO. 1: All documents relating to the contract.', 'RESPONSE TO REQUEST NO. 1: Plaintiff will produce them.']);
});

test('ranges', () => {
  assert.equal(ranges([1, 2, 3, 5, 7, 8]), 'S1–S3, S5, S7–S8');
});
