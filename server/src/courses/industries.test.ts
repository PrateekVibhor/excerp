// Plan 16, part 3: the industries a reader can pick when asking for a course. Each has a key the API takes and a phrase the research uses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INDUSTRIES, industryPhrase, isIndustryKey } from './industries.ts';

test('every industry has a unique lower-case key, a label, and a phrase short enough for the research prompts', () => {
  assert.ok(INDUSTRIES.length >= 12);
  assert.equal(new Set(INDUSTRIES.map((i) => i.key)).size, INDUSTRIES.length);
  for (const i of INDUSTRIES) {
    assert.match(i.key, /^[a-z]+(-[a-z]+)*$/, i.key);
    assert.ok(i.label.length >= 3 && i.label.length <= 40, i.label);
    assert.ok(i.phrase.length >= 3 && i.phrase.length <= 60 && i.phrase.split(/\s+/).length <= 6, i.phrase); // the guess is capped the same way
  }
});

test('the industries the owner named are there', () => {
  for (const k of ['fintech', 'banking', 'technology', 'supply-chain', 'e-commerce', 'healthcare']) assert.ok(isIndustryKey(k), k);
});

test('a key is recognised only exactly; the phrase for it is the research phrase, and there is none for anything else', () => {
  assert.equal(isIndustryKey('fintech'), true);
  for (const bad of ['Fintech', ' fintech', 'fin tech', '', 'other', 7, null, undefined, {}]) assert.equal(isIndustryKey(bad), false, JSON.stringify(bad));
  assert.equal(industryPhrase('fintech'), 'fintech and payments software');
  assert.equal(industryPhrase(''), '');
  assert.equal(industryPhrase('nonsense'), '');
});
