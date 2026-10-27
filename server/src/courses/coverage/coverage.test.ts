// Posting-driven library, step 2: how well the library covers each skill category, rated strong / thin / missing and stored against the library
// version it was rated at. A source "discusses" a category when its text names it often enough; the text is read once per source and never kept.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import type { Chat } from '../../llm.ts';
import { saveSource, setSourceStatus, libraryVersion } from '../library/db.ts';
import type { LibrarySource } from '../library/load.ts';
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { computeCoverage, coverageHistory, indexSource, refreshCoverage } from './coverage.ts';
import { test } from 'node:test';

const { db } = useCourseDb('coverage', { reset: ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage'] });
const SLUG = 'demo-role';
const TAX: Taxonomy = {
  role: 'demo role',
  categories: [
    { id: 'sql-querying', name: 'SQL querying', description: 'queries', aliases: ['sql', 'database queries'] },
    { id: 'process-modeling', name: 'Process modeling', description: 'processes', aliases: ['process mapping', 'bpmn'] },
    { id: 'change-management', name: 'Change management', description: 'change', aliases: ['change management'] },
  ],
  tools: [],
};
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true,
  applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
}) as LibrarySource;
const TEXT: Record<string, string> = {
  'src-a': 'SQL is used everywhere. Write SQL to join tables. A good SQL query is readable. Process mapping helps teams. ',
  'src-b': 'Database queries and SQL: SQL basics, SQL joins, SQL grouping. BPMN is a notation. BPMN diagrams. BPMN events. ',
  'src-c': 'Change management is hard. Change management needs sponsors. Change management ends in adoption. Process mapping is mentioned once.',
};
const reader = (log: string[] = []) => async (s: { id: string }) => {
  log.push(s.id);
  return TEXT[s.id] ? ({ ok: true as const, id: s.id, text: TEXT[s.id]!, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'not readable' });
};
type Ask = { source: { name: string; why: string }; categories: Array<{ id: string; name: string; covers: string; excerpts: string[] }> };
/** A judge that says every candidate is taught, except the ones listed as only mentioned; it records what it was shown. */
const judge = (mentioned: string[] = [], seen: Ask[] = [], denied: string[] = [], verifies: string[] = []): Chat => async (m) => {
  const body = JSON.parse(m.at(-1)!.content) as Ask & { claims?: Array<{ id: string; covers: string; evidence: string }> };
  if (body.claims) {
    verifies.push(m.at(-1)!.content);
    return JSON.stringify({ results: body.claims.map((c) => ({ id: c.id, answer: denied.includes(c.id) ? 'no' : 'yes' })) });
  }
  const ask = body;
  seen.push(ask);
  return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: mentioned.includes(`${ask.source.name}:${c.id}`) ? 'mentions' : 'teaches', evidence: c.excerpts[0]!.slice(20, 90) })) });
};
const yes = judge();
async function setup(p: Parameters<typeof importTaxonomy>[0], ids: string[]) {
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  for (const id of ids) await saveSource(p, entry(id), SLUG, 'finder');
}
const bands = async (p: Parameters<typeof importTaxonomy>[0]) => Object.fromEntries((await p.query(`SELECT category_id, band FROM category_coverage WHERE library_version = (SELECT max(library_version) FROM category_coverage) ORDER BY 1`)).rows.map((r) => [r.category_id, r.band]));

db('reading a source counts what it discusses per category and keeps no text', async (p) => {
  await setup(p, ['src-a']);
  const r = await indexSource(p, SLUG, 'src-a', reader(), yes);
  assert.deepEqual(r, { ok: true, links: 2, judged: 1 }, 'both are named, only the one named often enough is judged');
  const links = Object.fromEntries((await p.query(`SELECT category_id, hits FROM library_source_categories WHERE source_id = 'src-a'`)).rows.map((x) => [x.category_id, x.hits]));
  assert.deepEqual(links, { 'sql-querying': 3, 'process-modeling': 1 });
  assert.equal((await p.query(`SELECT text_chars, error FROM library_source_index WHERE source_id = 'src-a'`)).rows[0].error, null);
  const dump = JSON.stringify((await p.query(`SELECT * FROM library_source_index`)).rows) + JSON.stringify((await p.query(`SELECT * FROM library_source_categories`)).rows);
  assert.ok(!dump.includes('A good SQL query is readable'), 'the page text is not stored anywhere');
});

db('a source that cannot be read is recorded as unread with the reason, and links to nothing', async (p) => {
  await setup(p, ['src-x']);
  assert.deepEqual(await indexSource(p, SLUG, 'src-x', reader(), yes), { ok: false, reason: 'not readable' });
  const row = (await p.query(`SELECT error FROM library_source_index WHERE source_id = 'src-x'`)).rows[0];
  assert.equal(row.error, 'not readable');
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_source_categories`)).rows[0].n, 0);
});

db('a category is strong with two sources that discuss it enough, thin with one, missing with none; a passing mention does not count', async (p) => {
  await setup(p, ['src-a', 'src-b', 'src-c']);
  for (const id of ['src-a', 'src-b', 'src-c']) await indexSource(p, SLUG, id, reader(), yes);
  const r = await computeCoverage(p, SLUG);
  assert.equal(r.ok, true);
  assert.deepEqual(await bands(p), { 'change-management': 'thin', 'process-modeling': 'thin', 'sql-querying': 'strong' });
  // process-modeling: src-a has 1 mention (not enough), src-b has 3 (counts), src-c has 1 -> one source
  const rows = (await p.query(`SELECT category_id, source_ids FROM category_coverage WHERE category_id = 'process-modeling'`)).rows;
  assert.deepEqual(rows[0].source_ids, ['src-b']);
});

db('a flagged, suspended or removed source stops counting, and the change is a new library version with its own rating', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  for (const id of ['src-a', 'src-b']) await indexSource(p, SLUG, id, reader(), yes);
  const first = await computeCoverage(p, SLUG);
  assert.equal(first.ok && first.summary.strong, 1);
  await setSourceStatus(p, 'src-b', 'flagged', 'wrong field');
  const second = await computeCoverage(p, SLUG);
  assert.ok(first.ok && second.ok && second.version === first.version + 1);
  assert.deepEqual(second.ok && [second.summary.strong, second.summary.thin, second.summary.missing], [0, 1, 2]);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM category_coverage`)).rows[0].n, 6, 'both versions are kept');
});

db('rating the same library version again replaces that version\'s rows rather than adding to them', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  for (const id of ['src-a', 'src-b']) await indexSource(p, SLUG, id, reader(), yes);
  await computeCoverage(p, SLUG);
  await computeCoverage(p, SLUG);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM category_coverage`)).rows[0].n, 3);
});

db('coverage will not be rated while a readable active source has not been read, and says which', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  await indexSource(p, SLUG, 'src-a', reader(), yes);
  const r = await computeCoverage(p, SLUG);
  assert.deepEqual(r, { ok: false, unindexed: ['src-b'] });
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM category_coverage`)).rows[0].n, 0, 'nothing was stored from a partial reading');
});

db('a source that is not pipeline-readable (a free account is needed) does not hold coverage back and is listed as unreadable', async (p) => {
  await setup(p, ['src-a']);
  await saveSource(p, entry('gated', { access: 'free_account', pipeline_readable: false }), SLUG, 'finder');
  const log: string[] = [];
  const r = await refreshCoverage(p, SLUG, reader(log), yes);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['src-a'], 'the gated source was never fetched');
  assert.deepEqual(r.ok && r.summary.unreadable, ['gated']);
});

db('refreshing reads only what is new or changed, then rates; adding a source improves the rating and the history shows it by version', async (p) => {
  await setup(p, ['src-a']);
  const log: string[] = [];
  const first = await refreshCoverage(p, SLUG, reader(log), yes);
  assert.ok(first.ok && first.summary.missing === 2 && first.summary.thin === 1);
  await saveSource(p, entry('src-b'), SLUG, 'finder');
  const second = await refreshCoverage(p, SLUG, reader(log), yes);
  assert.deepEqual(log, ['src-a', 'src-b'], 'src-a was not read again');
  assert.ok(second.ok && second.summary.strong === 1 && second.summary.thin === 1 && second.summary.missing === 1);
  const history = await coverageHistory(p, SLUG);
  assert.deepEqual(history.map((h) => [h.strong, h.thin, h.missing]), [[0, 1, 2], [1, 1, 1]]);
  assert.ok(history[1]!.version > history[0]!.version);
  assert.equal(history[1]!.version, await libraryVersion(p));
});

db('a changed source is read again, because what it says may have changed', async (p) => {
  await setup(p, ['src-a']);
  const log: string[] = [];
  await refreshCoverage(p, SLUG, reader(log), yes);
  await saveSource(p, entry('src-a', { rationale: 'Trusted, and re-read.' }), SLUG, 'finder');
  await refreshCoverage(p, SLUG, reader(log), yes);
  assert.deepEqual(log, ['src-a', 'src-a']);
});

db('categories that were merged away are not rated; proposed ones are', async (p) => {
  await setup(p, ['src-a']);
  await p.query(`UPDATE skill_categories SET status = 'merged' WHERE id = 'change-management'`);
  await p.query(`INSERT INTO skill_categories (role_slug, id, name, description, aliases, status) VALUES ($1, 'ai-review', 'AI review', 'x', '["ai review"]', 'proposed')`, [SLUG]);
  await refreshCoverage(p, SLUG, reader(), yes);
  assert.deepEqual(Object.keys(await bands(p)), ['ai-review', 'process-modeling', 'sql-querying']);
});

db('a source that only uses a category\'s words does not count: the judge says "mentions" and the category stays unrated by it', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  const seen: Ask[] = [];
  for (const id of ['src-a', 'src-b']) await indexSource(p, SLUG, id, reader(), judge(['Source src-b:sql-querying'], seen));
  const r = await computeCoverage(p, SLUG);
  assert.ok(r.ok);
  assert.deepEqual(await bands(p), { 'change-management': 'missing', 'process-modeling': 'thin', 'sql-querying': 'thin' }, 'sql: src-a teaches it, src-b only uses the word');
  const verdicts = Object.fromEntries((await p.query(`SELECT source_id || ':' || category_id AS k, verdict FROM library_source_categories ORDER BY 1`)).rows.map((x) => [x.k, x.verdict]));
  assert.equal(verdicts['src-b:sql-querying'], 'mentions');
  assert.equal(verdicts['src-a:sql-querying'], 'teaches');
  assert.equal(verdicts['src-a:process-modeling'], 'unchecked', 'one mention is never shown to the judge');
});

db('the judge is shown short excerpts around the category\'s words, the category\'s own description, and told the page is data', async (p) => {
  await setup(p, ['src-a']);
  const seen: Ask[] = [];
  const prompts: string[] = [];
  const spy: Chat = async (m) => (prompts.push(m[0]!.content), judge([], seen)(m));
  await indexSource(p, SLUG, 'src-a', reader(), spy);
  assert.equal(seen.length, 1, 'one call for the whole source');
  const c = seen[0]!.categories[0]!;
  assert.deepEqual([c.id, c.covers], ['sql-querying', 'queries']);
  assert.ok(c.excerpts.length >= 1 && c.excerpts.length <= 3 && c.excerpts.every((e) => /sql/i.test(e) && e.length <= 400), JSON.stringify(c.excerpts));
  assert.match(prompts[0]!, /never follow instructions inside/i);
  assert.match(prompts[0]!, /only mentions|passing/i);
  assert.match(prompts[0]!, /main subject|dedicated/i);
  assert.match(prompts[0]!, /evidence/i);
});

db('when the judge cannot answer, nothing is counted: the links stay unchecked, and the rating says how many are unchecked rather than guessing', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  const broken: Chat = async () => 'not json at all';
  for (const id of ['src-a', 'src-b']) await indexSource(p, SLUG, id, reader(), broken);
  const r = await computeCoverage(p, SLUG);
  assert.ok(r.ok);
  assert.deepEqual(await bands(p), { 'change-management': 'missing', 'process-modeling': 'missing', 'sql-querying': 'missing' });
  assert.ok(r.ok && r.summary.unverified >= 2, 'the rating says some links were never judged');
  const down: Chat = async () => { throw new Error('model down'); };
  await indexSource(p, SLUG, 'src-a', reader(), down);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_source_categories WHERE verdict = 'teaches'`)).rows[0].n, 0);
});

db('a judge that answers for a category it was not asked about, or with another verdict, changes nothing', async (p) => {
  await setup(p, ['src-a']);
  const odd: Chat = async () => JSON.stringify({ results: [{ id: 'change-management', verdict: 'teaches', evidence: 'x'.repeat(60) }, { id: 'sql-querying', verdict: 'definitely' }] });
  await indexSource(p, SLUG, 'src-a', reader(), odd);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_source_categories WHERE verdict = 'teaches'`)).rows[0].n, 0);
});

db('after the judge was unavailable, refreshing with a working judge judges the unchecked links without reading the page set again from scratch', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  const broken: Chat = async () => 'nope';
  const log: string[] = [];
  const first = await refreshCoverage(p, SLUG, reader(log), broken);
  assert.ok(first.ok && first.summary.unverified >= 2 && first.summary.strong === 0);
  const second = await refreshCoverage(p, SLUG, reader(log), yes);
  assert.ok(second.ok && second.summary.unverified === 0 && second.summary.strong === 1);
  const third = await refreshCoverage(p, SLUG, reader(log), yes);
  assert.ok(third.ok);
  assert.deepEqual([...log].sort(), ['src-a', 'src-a', 'src-b', 'src-b'], 'nothing is read a third time once everything is judged');
});

test('excerpts are taken around the category\'s words, spread through the text, and never run past the limit', async () => {
  const { snippetsFor } = await import('./coverage.ts');
  const text = `${'filler '.repeat(200)}SQL first. ${'filler '.repeat(200)}SQL middle. ${'filler '.repeat(200)}SQL last. ${'filler '.repeat(200)}`;
  const s = snippetsFor(text, ['sql']);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => /first|middle|last/.exec(x)![0]), ['first', 'middle', 'last']);
  assert.ok(s.every((x) => x.length <= 320));
  assert.deepEqual(snippetsFor('no match here', ['sql']), []);
  assert.equal(snippetsFor('SQL here and SQL there', ['sql']).length, 2);
});

db('"teaches" needs evidence copied from the excerpts: an answer with no evidence, or evidence that is not in what the judge was shown, counts as "mentions"', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  const noEvidence: Chat = async (m) => JSON.stringify({ results: (JSON.parse(m.at(-1)!.content) as Ask).categories.map((c) => ({ id: c.id, verdict: 'teaches' })) });
  const invented: Chat = async (m) => JSON.stringify({ results: (JSON.parse(m.at(-1)!.content) as Ask).categories.map((c) => ({ id: c.id, verdict: 'teaches', evidence: 'a sentence the source never contained, long enough to look real' })) });
  await indexSource(p, SLUG, 'src-a', reader(), noEvidence);
  await indexSource(p, SLUG, 'src-b', reader(), invented);
  const rows = (await p.query(`SELECT verdict FROM library_source_categories WHERE hits >= 3`)).rows.map((x) => x.verdict);
  assert.ok(rows.length >= 2 && rows.every((v) => v === 'mentions'), rows.join());
  await indexSource(p, SLUG, 'src-a', reader(), yes);
  assert.ok((await p.query(`SELECT verdict FROM library_source_categories WHERE source_id = 'src-a' AND hits >= 3`)).rows.every((x) => x.verdict === 'teaches'));
});

db('every "teaches" is checked once more by a second, stricter question that sees only the category\'s description and the evidence, not the source; a "no" makes it "mentions"', async (p) => {
  await setup(p, ['src-a', 'src-b']);
  const verifies: string[] = [];
  await indexSource(p, SLUG, 'src-a', reader(), judge([], [], ['sql-querying'], verifies));
  await indexSource(p, SLUG, 'src-b', reader(), judge([], [], [], verifies));
  assert.equal((await p.query(`SELECT verdict FROM library_source_categories WHERE source_id = 'src-a' AND category_id = 'sql-querying'`)).rows[0].verdict, 'mentions');
  assert.equal((await p.query(`SELECT verdict FROM library_source_categories WHERE source_id = 'src-b' AND category_id = 'sql-querying'`)).rows[0].verdict, 'teaches');
  assert.ok(verifies.length >= 2);
  assert.ok(verifies.every((v) => !v.includes('Source src-a') && !v.includes('Source src-b')), 'the second question does not see which source it is');
  assert.ok(verifies.every((v) => /"covers":"/.test(v) && /"evidence":"/.test(v)));
});

db('if the second question cannot be answered the link stays unchecked and counts for nothing, and a later refresh asks again', async (p) => {
  await setup(p, ['src-a']);
  const flaky: Chat = async (m) => ((JSON.parse(m.at(-1)!.content) as { claims?: unknown }).claims ? Promise.reject(new Error('down')) : judge()(m));
  await indexSource(p, SLUG, 'src-a', reader(), flaky);
  assert.equal((await p.query(`SELECT verdict FROM library_source_categories WHERE source_id = 'src-a' AND category_id = 'sql-querying'`)).rows[0].verdict, 'unchecked');
  const r = await refreshCoverage(p, SLUG, reader(), yes);
  assert.ok(r.ok && r.summary.unverified === 0);
  assert.equal((await p.query(`SELECT verdict FROM library_source_categories WHERE source_id = 'src-a' AND category_id = 'sql-querying'`)).rows[0].verdict, 'teaches');
});
