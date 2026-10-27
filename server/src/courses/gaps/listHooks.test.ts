// The notification loop is wired in: after sources are admitted, and after an audit removes some, every ready list course of the role is refreshed. A reader
// is told about a concept only after the library has admitted a source, rated it, and the course's own rating of that concept has gone up.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, publishedListCourse } from '../../../testkit/courseFixtures.ts';
import type { Chat } from '../../llm.ts';
import type { Hit, SearchClient } from '../pipeline/postings.ts';
import { enrolReader } from '../enrol.ts';
import { libraryVersion, saveSource } from '../library/db.ts';
import type { LibrarySource } from '../library/load.ts';
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { admitAndRate, auditAndRate } from './admit.ts';
import { createBudget } from './budget.ts';
import { runFinder } from './finder.ts';
import { reconcileGaps } from './gaps.ts';

const TABLES = ['roles', 'accounts', 'library_sources', 'library_role_files', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage', 'library_gaps', 'library_candidates'];
const { db } = useCourseDb('listhooks', { reset: TABLES });
const SLUG = 'demo-role';
const NOW = new Date('2026-10-25T12:00:00Z');
const TAX: Taxonomy = { role: 'demo role', categories: [{ id: 'skill-3', name: 'Skill 3', description: 'the third skill of the role', aliases: ['skill 3'] }], tools: [] };
const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);
const WEB: Record<string, string> = { 'https://good.example.org/skill3': `${filler(3)}Skill 3 explained. Learn skill 3. Practise skill 3. More on skill 3. ${filler(3)}` };
const read = async (s: { id: string; url: string }) => (WEB[s.url] ? ({ ok: true as const, id: s.id, text: WEB[s.url]!, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
const model = (mentionsFor: string[] = []): Chat => async (m) => {
  const system = m[0]!.content;
  const user = m.at(-1)!.content;
  if (/web page is a good source/.test(system)) return JSON.stringify({ keep: true, kind: 'secondary', why: 'a clear explanation for analysts' });
  if (/MAIN SUBJECT/.test(system)) return JSON.stringify({ answer: 'yes' });
  if (/TEACHES a skill or only mentions it/.test(system)) {
    const ask = JSON.parse(user) as { source: { name: string }; categories: Array<{ id: string; excerpts: string[] }> };
    return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: mentionsFor.some((x) => ask.source.name.includes(x)) ? 'mentions' : 'teaches', evidence: (c.excerpts[0] ?? '').slice(10, 80) })) });
  }
  return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
};
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over }) as LibrarySource;

async function world(p: Parameters<typeof importTaxonomy>[0]) {
  const c = await publishedListCourse(p, { concepts: 4, roleName: 'demo role' });
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('lib-one', { url: 'https://links.example.org/0/0' }), SLUG, 'seed');
  const reader = await account(p);
  await enrolReader(p, reader, c.courseId, 'demo role', NOW);
  await p.query(`UPDATE list_concepts SET library_version = $2 WHERE course_id = $1`, [c.courseId, await libraryVersion(p)]);
  const v = await libraryVersion(p);
  await p.query(`INSERT INTO category_coverage (role_slug, category_id, library_version, band, min_hits, source_ids) VALUES ($1,'skill-3',$2,'missing',3,'[]')`, [SLUG, v]);
  await reconcileGaps(p, SLUG);
  const search: SearchClient = { search: async () => [{ url: 'https://good.example.org/skill3', title: 'Page skill3', text: '' } as Hit] };
  await runFinder({ pool: p, chat: model(), search, read, budget: createBudget({ perGap: 4, batch: 20, ledger: { charge() {} } }), now: () => NOW }, SLUG, ['skill-3']);
  return { ...c, reader };
}
const changeRows = async (p: Parameters<typeof importTaxonomy>[0], courseId: string) => (await p.query(`SELECT target, summary FROM course_changes WHERE course_id = $1`, [courseId])).rows;

db('admitting a source that teaches a concept the list course lacks tells that course\'s readers, and only about that concept', async (p) => {
  const c = await world(p);
  assert.deepEqual(await changeRows(p, c.courseId), [], 'a candidate the finder found is not news');
  const out = await admitAndRate({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  assert.equal(out.admission.admitted.length, 1);
  assert.deepEqual([out.lists.courses, out.lists.notified, out.lists.errors], [1, 1, 0]);
  const rows = await changeRows(p, c.courseId);
  assert.deepEqual(rows.map((r) => r.target), [c.conceptIds[2]]);
  assert.match(rows[0]!.summary, /now thin, with 1 vetted source \(was missing\)/);
});

db('a source the rating would not count is not admitted, so nobody is told anything', async (p) => {
  const c = await world(p);
  const only = await admitAndRate({ pool: p, chat: model(['Page']), read, now: () => NOW }, SLUG);
  assert.equal(only.admission.admitted.length, 0);
  assert.deepEqual(await changeRows(p, c.courseId), []);
});

db('an audit that removes a source the list course showed lowers its stored rating quietly: no version, no change row', async (p) => {
  const c = await world(p);
  await admitAndRate({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  const versionsBefore = (await p.query(`SELECT count(*)::int AS n FROM course_versions WHERE course_id = $1`, [c.courseId])).rows[0].n;
  const changesBefore = (await changeRows(p, c.courseId)).length;
  // the source the list course now shows for the third concept fails the audit: its stored verdict is "mentions"
  await p.query(`INSERT INTO library_source_categories (source_id, role_slug, category_id, hits, verdict) SELECT id, $1, 'skill-3', 4, 'mentions' FROM library_sources WHERE origin = 'finder' ON CONFLICT DO NOTHING`, [SLUG]);
  await p.query(`UPDATE library_source_categories SET verdict = 'mentions' WHERE category_id = 'skill-3'`);
  const out = await auditAndRate({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  assert.equal(out.removed.length, 1);
  assert.deepEqual([out.lists.courses, out.lists.notified, out.lists.errors], [1, 0, 0]);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM course_versions WHERE course_id = $1`, [c.courseId])).rows[0].n, versionsBefore);
  assert.equal((await changeRows(p, c.courseId)).length, changesBefore);
  const band = (await p.query(`SELECT l.band FROM list_concepts l JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 AND l.concept_id = $2`, [c.courseId, c.conceptIds[2]])).rows[0].band;
  assert.equal(band, 'missing');
});

db('a failure while refreshing the lists never undoes or fails an admission', async (p) => {
  await world(p);
  await p.query(`ALTER TABLE list_concepts RENAME TO list_concepts_x`);
  try {
    const out = await admitAndRate({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
    assert.equal(out.admission.admitted.length, 1);
    assert.equal(out.lists.errors >= 1, true);
  } finally {
    await p.query(`ALTER TABLE list_concepts_x RENAME TO list_concepts`);
  }
});
