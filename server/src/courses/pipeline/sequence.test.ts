import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { sequenceConcepts } from './sequence.ts';

const concepts = [{ name: 'debugging', mentions: 6 }, { name: 'sql', mentions: 9 }, { name: 'leading others', mentions: 3 }, { name: 'what the job is', mentions: 2 }, { name: 'python', mentions: 9 }];
/** A model that answers the stage prompt and the prerequisite prompt separately. */
const model = (stages: number[] | Error, edges: Array<[number, number]> | Error): Chat => async (m) => {
  const out = /prerequisite/i.test(m[0]!.content) ? edges : stages;
  if (out instanceof Error) throw out;
  return JSON.stringify(/prerequisite/i.test(m[0]!.content) ? { edges: out } : { stages: out });
};

test('approach B: concepts go in stage order, and within a stage the more asked-for come first, ties alphabetical', async () => {
  const r = await sequenceConcepts(model([3, 2, 4, 1, 2], []), 'backend engineer', concepts);
  assert.deepEqual(r.order, ['what the job is', 'python', 'sql', 'debugging', 'leading others']);
  assert.equal(r.approach, 'B');
});

test('every concept appears exactly once, whatever the model does', async () => {
  const r = await sequenceConcepts(model([1, 1, 1, 1, 1], [[1, 2]]), 'r', concepts);
  assert.deepEqual([...r.order].sort(), concepts.map((c) => c.name).sort());
});

test('the automatic order check: an order that breaks few prerequisites is kept, one that breaks more than a fifth is repaired from the prerequisites', async () => {
  // B puts "leading others" (index 3, stage 4) after "sql" (stage 2), so the edge leading others -> sql is violated in 1 of 1 edges.
  const edges: Array<[number, number]> = [[3, 2]];
  const r = await sequenceConcepts(model([3, 2, 4, 1, 2], edges), 'r', concepts);
  assert.equal(r.approach, 'A-repair');
  assert.ok(r.order.indexOf('leading others') < r.order.indexOf('sql'));
  const kept = await sequenceConcepts(model([3, 2, 4, 1, 2], [[2, 1]]), 'r', concepts); // sql before debugging: already true
  assert.equal(kept.approach, 'B');
  assert.equal(kept.violations, 0);
});

test('when the model cannot give stages the order falls back to most asked-for first, and says so', async () => {
  const r = await sequenceConcepts(model(new Error('down'), []), 'r', concepts);
  assert.equal(r.approach, 'baseline');
  assert.deepEqual(r.order.slice(0, 2), ['python', 'sql']);
  assert.equal(r.order.at(-1), 'what the job is');
});

test('failing prerequisites do not fail the sequence: the stage order stands', async () => {
  const r = await sequenceConcepts(model([3, 2, 4, 1, 2], new Error('down')), 'r', concepts);
  assert.equal(r.approach, 'B');
});
