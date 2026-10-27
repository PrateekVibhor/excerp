// A shared concept may only carry a name and variants that a public posting actually used. A reader's own wording is still gathered under the concept for this build
// (so their posting counts for the list), but it is kept apart: `terms` is everything, `publicTerms` is what public postings used. No network and no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { buildConcepts, type PostingEvidence } from './rank.ts';

const posting = (skills: string[], counts = true): PostingEvidence => ({ skills, scenarios: [], countsForCriticality: counts });
/** A merge step that answers with the given groups. */
const merges = (groups: Array<{ name: string; variants: string[] }>): Chat => async () => JSON.stringify({ groups });
const PUBLIC = [posting(['sql', 'debugging']), posting(['sql', 'debugging']), posting(['sql'])];
const named = (cs: Awaited<ReturnType<typeof buildConcepts>>, name: string) => cs.find((c) => c.name === name);

test('a reader phrase merged with a public name leaves the concept with the public name, only the public variants in publicTerms, and the reader\'s wording kept in terms for the build', async () => {
  const out = await buildConcepts(merges([{ name: 'sql', variants: ['writing sql queries'] }]), [...PUBLIC, posting(['writing sql queries'], false)]);
  const sql = named(out, 'sql')!;
  assert.deepEqual(sql.publicTerms, ['sql']);
  assert.deepEqual([...sql.terms].sort(), ['sql', 'writing sql queries']);
  assert.equal(sql.fromReaderSource, false);
  assert.equal(out.some((c) => c.name === 'writing sql queries'), false);
});

test('when the model names the group with a reader phrase, or with a name no public posting used, the name is replaced by a public name from the group', async () => {
  const reader = posting(['writing sql queries'], false);
  const byReaderPhrase = await buildConcepts(merges([{ name: 'writing sql queries', variants: ['sql'] }]), [...PUBLIC, reader]);
  assert.deepEqual(byReaderPhrase.map((c) => c.name).filter((n) => n.includes('sql')), ['sql']);
  assert.deepEqual(named(byReaderPhrase, 'sql')!.publicTerms, ['sql']);
  assert.deepEqual([...named(byReaderPhrase, 'sql')!.terms].sort(), ['sql', 'writing sql queries']);

  const invented = await buildConcepts(merges([{ name: 'sql mastery', variants: ['sql', 'writing sql queries'] }]), [...PUBLIC, reader]);
  assert.deepEqual(invented.map((c) => c.name).filter((n) => n.includes('sql')), ['sql']);
});

test('the replacement is chosen the same way every time: the public name most public postings used, then alphabetical', async () => {
  const postings = [posting(['database querying']), posting(['database querying']), posting(['sql']), posting(['sql']), posting(['sql']), posting(['query design']), posting(['query design']), posting(['query design'])];
  const group = merges([{ name: 'invented name', variants: ['database querying', 'sql', 'query design'] }]);
  const first = await buildConcepts(group, [...postings, posting(['writing queries'], false)]);
  assert.deepEqual(first.filter((c) => !c.fromReaderSource).map((c) => c.name), ['query design']); // sql and query design tie at 3 public postings: alphabetical, "query design" first
  const again = await buildConcepts(group, [posting(['writing queries'], false), ...postings.slice().reverse()]);
  assert.deepEqual(again.filter((c) => !c.fromReaderSource).map((c) => c.name), ['query design']);
  const clear = await buildConcepts(merges([{ name: 'invented name', variants: ['database querying', 'sql'] }]), postings.slice(0, 5));
  assert.deepEqual(clear.map((c) => c.name), ['sql'], 'three public postings beat two');
});

test('the reader\'s list is weighted exactly as before: counts, criticality and the reader-only marking do not change, and their wording still maps to the concept', async () => {
  const withReader = await buildConcepts(merges([{ name: 'writing sql queries', variants: ['sql'] }]), [...PUBLIC, posting(['writing sql queries'], false)]);
  const without = await buildConcepts(merges([]), PUBLIC);
  const a = named(withReader, 'sql')!;
  const b = named(without, 'sql')!;
  assert.deepEqual([a.mentions, a.of, a.criticality, a.fromReaderSource], [b.mentions, b.of, b.criticality, b.fromReaderSource]);
  assert.ok(a.terms.includes('writing sql queries'), 'the reader\'s phrase still resolves to this concept');
});

test('a group made only of reader phrases stays private, under the wording the model chose, with no public variants', async () => {
  const out = await buildConcepts(merges([{ name: 'tableau dashboards', variants: ['tableau dashboarding'] }]), [...PUBLIC, posting(['tableau dashboards', 'tableau dashboarding'], false)]);
  const t = named(out, 'tableau dashboards')!;
  assert.equal(t.fromReaderSource, true);
  assert.deepEqual(t.publicTerms, []);
  assert.deepEqual([...t.terms].sort(), ['tableau dashboarding', 'tableau dashboards']);
});

test('with no reader posting nothing changes: every variant is public', async () => {
  const out = await buildConcepts(merges([{ name: 'sql', variants: ['writing sql queries'] }]), [posting(['sql']), posting(['writing sql queries']), posting(['debugging']), posting(['debugging'])]);
  const sql = named(out, 'sql')!;
  assert.deepEqual([...sql.publicTerms!].sort(), ['sql', 'writing sql queries']);
  assert.equal(sql.mentions, 2);
});
