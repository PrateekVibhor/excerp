import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { buildConcepts, type PostingEvidence } from './rank.ts';

const noMerge: Chat = async () => JSON.stringify({ groups: [] });
const posting = (skills: string[], scenarios: string[] = [], counts = true): PostingEvidence => ({ skills, scenarios, countsForCriticality: counts });
const n = (count: number, make: (i: number) => PostingEvidence) => Array.from({ length: count }, (_, i) => make(i));

test('the same skill written differently is one concept, and the names used become its terms', async () => {
  const merge: Chat = async () => JSON.stringify({ groups: [{ name: 'sql', variants: ['writing sql queries', 'sql'] }] });
  const c = await buildConcepts(merge, [posting(['SQL']), posting(['Writing SQL queries']), posting(['Python'])]);
  const sql = c.find((x) => x.name === 'sql')!;
  assert.equal(sql.mentions, 2);
  assert.deepEqual(sql.terms.sort(), ['sql', 'writing sql queries']);
});

test('a skill needs two mentions, and the bands sit at 25% and 60% of the postings', async () => {
  const ps = n(10, (i) => posting([...(i < 6 ? ['high skill'] : []), ...(i < 3 ? ['medium skill'] : []), ...(i < 2 ? ['low skill'] : []), ...(i === 0 ? ['once only'] : [])]));
  const c = await buildConcepts(noMerge, ps);
  assert.deepEqual(c.map((x) => [x.name, x.mentions, x.criticality]), [['high skill', 6, 'high'], ['medium skill', 3, 'medium'], ['low skill', 2, 'low']]);
  assert.ok(!c.some((x) => x.name === 'once only'));
  const edge = await buildConcepts(noMerge, n(4, (i) => posting(i < 1 ? ['quarter'] : i < 2 ? ['quarter'] : [])));
  assert.equal(edge[0]!.criticality, 'medium'); // 2 of 4 postings is 50%: medium, and exactly 25% would also be medium
});

test('scenarios are concepts of their own kind, counted and banded like skills, and never mixed with skills of the same name', async () => {
  const ps = n(4, () => posting(['debugging'], ['debugging']));
  const c = await buildConcepts(noMerge, ps);
  assert.deepEqual(c.map((x) => [x.kind, x.name]).sort(), [['scenario', 'debugging'], ['skill', 'debugging']]);
  assert.ok(c.every((x) => x.criticality === 'high'));
});

test('a postings the reader added themselves does not count: a concept only it asks for is marked and gets no badge', async () => {
  const ps = [...n(5, () => posting(['sql'])), posting(['sql', 'rust'], [], false), posting(['rust'], [], false)];
  const c = await buildConcepts(noMerge, ps);
  assert.equal(c.find((x) => x.name === 'sql')!.mentions, 5); // the reader's posting is not a mention
  const rust = c.find((x) => x.name === 'rust')!;
  assert.deepEqual([rust.fromReaderSource, rust.criticality], [true, null]);
  assert.equal(c.find((x) => x.name === 'sql')!.fromReaderSource, false);
});

test('reference material cannot change criticality: extra fields on the evidence are ignored', async () => {
  const ps = n(4, () => posting(['sql']));
  const base = await buildConcepts(noMerge, ps);
  const withRef = await buildConcepts(noMerge, ps.map((p) => ({ ...p, reference: ['an article that says sql is critical'], video: 'abc' })) as PostingEvidence[]);
  assert.deepEqual(withRef, base);
});

test('a failed merge call leaves names unmerged but still ranks', async () => {
  const c = await buildConcepts(async () => { throw new Error('down'); }, n(3, () => posting(['sql'])));
  assert.equal(c[0]!.mentions, 3);
});
