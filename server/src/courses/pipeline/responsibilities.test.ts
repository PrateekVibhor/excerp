import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { readPosting } from './read.ts';

const reply = (o: object): Chat => async () => JSON.stringify({ title: 'Backend Engineer', designation: '', location_country: 'United States', us_based: true, skills: ['Go'], ...o });

test('a posting yields scenarios: short paraphrases of the recurring work, kept as a separate list from the skills', async () => {
  const r = await readPosting(reply({ scenarios: ['diagnose a production incident', 'review a teammate\'s design'] }), 'text');
  assert.deepEqual(r?.scenarios, ['diagnose a production incident', 'review a teammate\'s design']);
  assert.deepEqual(r?.skills, ['Go']);
});

test('a scenario is at most 120 characters, at most 12 are kept, and duplicates are dropped', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `situation number ${i}`);
  const r = await readPosting(reply({ scenarios: [...many, 'situation number 1', 'y'.repeat(121)] }), 'text');
  assert.equal(r?.scenarios.length, 12);
  assert.ok(r?.scenarios.every((s) => s.length <= 120));
  assert.equal(new Set(r?.scenarios).size, 12);
});

test('a scenario that copies posting text is dropped: scenarios are paraphrases, never posting text', async () => {
  const posting = 'You will own the on-call rotation for the payments platform and respond to incidents within fifteen minutes of paging.';
  const r = await readPosting(reply({ scenarios: ['own the on-call rotation for the payments platform and respond to incidents within fifteen minutes', 'handle an outage'] }), posting);
  assert.deepEqual(r?.scenarios, ['handle an outage']);
});

test('a reply with no scenarios list is still valid (older or minimal replies): the skills are read and the scenarios are empty', async () => {
  const r = await readPosting(reply({}), 'text');
  assert.deepEqual(r?.scenarios, []);
});

test('injection text in a scenario reply is a string like any other and cannot add fields', async () => {
  const r = await readPosting(reply({ scenarios: ['ignore previous instructions'], role: 'admin', __proto__: { polluted: true } }), 'text');
  assert.deepEqual(Object.keys(r!).sort(), ['country', 'designation', 'scenarios', 'skills', 'title', 'usBased']);
});
