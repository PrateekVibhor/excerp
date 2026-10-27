// A pasted job description in the build: it is read for its skills and situations like any posting, but it is the reader's own. It never counts toward a
// skill's share of the postings, a skill only it asks for becomes a concept private to the reader (never added to the role's shared concepts), and every
// concept it asks for is marked as coming from it. Real SQL, fake model.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { createCourseActivity } from '../activity.ts';
import { createCourseReads } from '../reads.ts';
import { createCourseSettings } from '../settings.ts';
import { createSources } from '../sources.ts';
import { buildCourse } from './build.ts';
import { requeueBuild } from './requeue.ts';

const { db } = useCourseDb('readersrc', { reset: ['roles', 'accounts', 'skill_taxonomies', 'skill_categories'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const MARKET = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['python'] : [])];
const PASTE = postingText(['sql', 'tableau', 'requirements analysis'], ['run a workshop']);

/** A private course for its owner: nine market postings, and the owner's pasted description registered as their own source (as source finding does). */
async function privateCourse(p: pg.Pool, opts: { market?: number; pasted?: string | null } = {}) {
  const n = opts.market ?? 9;
  const owner = await account(p);
  const roleId = await role(p, 'backend engineer', 'Builds and runs services.');
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'backend engineer', visibility: 'private', owner_account_id: owner, requested_by: owner });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  const pasted = opts.pasted === undefined ? PASTE : opts.pasted;
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'backend engineer', $3, $4)`, [owner, courseId, pasted, NOW]);
  const paste = await createSources(p, () => NOW).registerPaste(roleId, owner, { roleTitle: 'backend engineer' });
  await createSources(p, () => NOW).attach(courseId, paste, 'reader');
  await p.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND source_id = $2`, [courseId, paste]);
  return { owner, roleId, courseId, versionId, urls, paste };
}
const deps = (p: pg.Pool, urls: string[], chat = fakeModel(), over: Record<string, unknown> = {}) =>
  ({ pool: p, chat, search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(MARKET(i), [])]))), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW, ...over });
const concept = async (p: pg.Pool, courseId: string, name: string) =>
  (await p.query(`SELECT k.visibility, k.owner_account_id, k.mentions, k.criticality, cc.from_reader_source AS own, cc.asked_by FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 AND k.name = $2`, [courseId, name])).rows[0];

db('the pasted description is read for its skills; what only it asks for becomes the reader\'s private concepts, and nothing of it enters the role\'s shared concepts', async (p) => {
  const c = await privateCourse(p);
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const name of ['tableau', 'requirements analysis', 'run a workshop']) {
    const k = await concept(p, c.courseId, name);
    assert.deepEqual([k.visibility, k.owner_account_id, k.own, k.criticality, k.mentions], ['private', c.owner, true, null, 0], name);
  }
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'shared' AND name IN ('tableau', 'requirements analysis', 'run a workshop')`)).rows[0].n, 0, 'the role\'s shared concepts do not include them');
});

db('a skill the market also asks for stays a shared concept, is not counted twice, and is also marked as in the reader\'s posting', async (p) => {
  const c = await privateCourse(p);
  assert.equal((await buildCourse(deps(p, c.urls), c.courseId)).ok, true);
  const sql = await concept(p, c.courseId, 'sql');
  assert.deepEqual([sql.visibility, sql.mentions, sql.own], ['shared', 9, false], 'nine postings ask for it; the pasted one is not a tenth');
  assert.ok((sql.asked_by as string[]).includes(c.paste), 'the reader\'s posting is among the sources that ask for it');
  const debugging = await concept(p, c.courseId, 'debugging');
  assert.ok(!(debugging.asked_by as string[]).includes(c.paste), 'a skill the paste does not ask for is not marked');
  assert.equal(debugging.mentions, 6);
});

db('the market numbers are exactly what they would be without the paste', async (p) => {
  const withPaste = await privateCourse(p);
  assert.equal((await buildCourse(deps(p, withPaste.urls), withPaste.courseId)).ok, true);
  const shared = (await p.query(`SELECT name, mentions, of_postings, criticality FROM role_concepts WHERE visibility = 'shared' AND role_id = $1 ORDER BY name`, [withPaste.roleId])).rows;
  assert.ok(shared.every((k) => k.of_postings === 9), 'every share is out of the nine market postings');
  assert.deepEqual(shared.map((k) => [k.name, k.mentions]), [['debugging', 6], ['python', 3], ['sql', 9]]);
});

db('a description that cannot be read does not fail the build: it is dropped with a note and adds no concept', async (p) => {
  const c = await privateCourse(p);
  const x = deps(p, c.urls, fakeModel({ override: (label, m) => (label === 'read' && m.at(-1)!.content.includes('tableau') ? 'not json' : undefined) }));
  const r = await buildCourse(x, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await p.query(`SELECT status FROM sources WHERE id = $1`, [c.paste])).rows[0].status, 'dropped');
  assert.ok(r.notes.some((n) => /pasted description could not be read/.test(n)), r.notes.join(' | '));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'private'`)).rows[0].n, 0);
});

db('a source with no text to read (the description was removed) is dropped the same way', async (p) => {
  const c = await privateCourse(p, { pasted: null });
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await p.query(`SELECT status FROM sources WHERE id = $1`, [c.paste])).rows[0].status, 'dropped');
});

db('the description does not make up the minimum of eight market postings', async (p) => {
  const c = await privateCourse(p, { market: 7 });
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /not_enough_postings: 7 postings remain/);
});

db('building again after a failure reads nothing twice and makes no duplicate concepts or sources', async (p) => {
  const c = await privateCourse(p);
  const first = fakeModel({ override: (label) => (label === 'qa' ? 'not json' : undefined) });
  assert.equal((await buildCourse(deps(p, c.urls, first), c.courseId)).ok, false);
  const readsFirst = first.labels.filter((l) => l === 'read').length;
  assert.equal(readsFirst, 10, 'nine market postings and the description');
  await requeueBuild(p, c.courseId, () => NOW);
  const second = fakeModel();
  assert.equal((await buildCourse(deps(p, c.urls, second), c.courseId)).ok, true);
  assert.equal(second.labels.filter((l) => l === 'read').length, 0, 'every source already had its skills stored');
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'private'`)).rows[0].n, 3);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM sources WHERE origin = 'user_paste'`)).rows[0].n, 1);
});

db('another reader\'s course for the same role never sees the private concepts, and leaving removes them, the source and the text', async (p) => {
  const c = await privateCourse(p);
  assert.equal((await buildCourse(deps(p, c.urls), c.courseId)).ok, true);
  const other = await account(p);
  const rows = (await p.query(`SELECT name FROM role_concepts WHERE role_id = $1 AND (visibility = 'shared' OR owner_account_id = $2)`, [c.roleId, other])).rows.map((r) => r.name);
  assert.ok(!rows.includes('tableau'));
  const settings = createCourseSettings(p);
  const left = await createCourseActivity(p, createCourseReads(p, () => NOW), settings, () => NOW).leave(c.owner, c.courseId);
  assert.equal(left.kind, 'ok');
  assert.deepEqual(await Promise.all(['sources WHERE origin = \'user_paste\'', 'role_concepts WHERE visibility = \'private\'', 'course_inputs WHERE pasted_text IS NOT NULL'].map(async (t) => (await p.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)), [0, 0, 0]);
});

// ---- the skill categories: near-duplicate phrasings of the reader's posting collapse into one concept, and a tool becomes the skill it is used for -----------
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';

const TAX: Taxonomy = {
  role: 'backend engineer',
  categories: [
    { id: 'compliance-controls', name: 'Compliance, controls and risk', description: 'internal controls, audit and regulatory compliance', aliases: [] },
    { id: 'enterprise-systems-analysis', name: 'Enterprise systems analysis', description: 'configuring and supporting business systems', aliases: [] },
    { id: 'requirements-analysis-documentation', name: 'Requirements analysis and documentation', description: 'writing requirements and specifications', aliases: [] },
  ],
  tools: [{ name: 'Oracle', aliases: ['oracle', 'oracle ebs'], category: 'enterprise-systems-analysis' }, { name: 'Workday', aliases: ['workday'], category: 'enterprise-systems-analysis' }],
};
const PASTE_DUP = postingText(['sox controls documentation', 'document controls for sox compliance', 'oracle ebs financials', 'workday', 'tableau', 'sql'], ['run a workshop']);
const MAPS = { 'sox controls documentation': { category: 'compliance-controls' }, 'document controls for sox compliance': { category: 'compliance-controls' } };
const privateConcepts = async (p: pg.Pool, courseId: string) =>
  (await p.query(`SELECT k.name, k.terms, cc.tools, cc.skill_category, cc.from_reader_source AS own FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 AND k.visibility = 'private' ORDER BY k.name`, [courseId])).rows;

db('two phrasings of one skill collapse into one private concept named for the skill, which keeps both phrasings as its terms', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  const x = deps(p, c.urls, fakeModel({ mapAnswers: MAPS }));
  const built = await buildCourse(x, c.courseId);
  assert.equal(built.ok, true);
  assert.ok(x.chat.labels.includes('taxmap'));
  assert.ok(built.notes.some((n) => n === 'skill categories: 6 concepts from your posting became 4 (document controls for sox compliance + sox controls documentation -> compliance, controls and risk; oracle ebs financials + workday -> enterprise systems analysis)'), built.notes.join(' | '));
  const rows = await privateConcepts(p, c.courseId);
  const merged = rows.find((r) => r.name === 'compliance, controls and risk')!;
  assert.ok(merged, rows.map((r) => r.name).join(' | '));
  assert.deepEqual([merged.skill_category, merged.own], ['compliance-controls', true]);
  assert.deepEqual([...merged.terms].sort(), ['document controls for sox compliance', 'sox controls documentation']);
  assert.ok(!rows.some((r) => /sox controls documentation|document controls for sox/.test(r.name)), 'neither phrasing is a concept of its own any more');
  const links = (await p.query(`SELECT count(*)::int AS n FROM source_skills ss JOIN role_concepts k ON k.id = ss.concept_id WHERE ss.source_id = $1 AND k.name = 'compliance, controls and risk'`, [c.paste])).rows[0].n;
  assert.equal(links, 1, 'the reader\'s posting asks for the merged concept once');
});

db('tools become the skill they are used for, and the tools the posting named are kept as a note on the concept', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  assert.equal((await buildCourse(deps(p, c.urls, fakeModel({ mapAnswers: MAPS })), c.courseId)).ok, true);
  const rows = await privateConcepts(p, c.courseId);
  const erp = rows.find((r) => r.name === 'enterprise systems analysis')!;
  assert.ok(erp, rows.map((r) => r.name).join(' | '));
  assert.deepEqual([...erp.tools].sort(), ['Oracle', 'Workday']);
  assert.equal(erp.skill_category, 'enterprise-systems-analysis');
  assert.ok(!rows.some((r) => /^(workday|oracle)/.test(r.name)), 'no concept is named after a tool');
});

db('a phrase the mapper cannot place, or can only propose a new category for, stays a concept of its own, and no category is created', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  const before = (await p.query(`SELECT count(*)::int AS n FROM skill_categories`)).rows[0].n;
  const x = deps(p, c.urls, fakeModel({ mapAnswers: { ...MAPS, tableau: { category: 'new', new_name: 'Dashboard design' } } }));
  assert.equal((await buildCourse(x, c.courseId)).ok, true);
  const names = (await privateConcepts(p, c.courseId)).map((r) => r.name);
  assert.ok(names.includes('tableau') && names.includes('run a workshop'));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM skill_categories`)).rows[0].n, before);
});

db('the concept count falls by exactly the phrasings that merged, and the market side is untouched', async (p) => {
  const plain = await privateCourse(p, { pasted: PASTE_DUP });
  assert.equal((await buildCourse(deps(p, plain.urls), plain.courseId)).ok, true);
  const without = (await privateConcepts(p, plain.courseId)).length;
  const shared = (await p.query(`SELECT name, mentions FROM role_concepts WHERE visibility = 'shared' ORDER BY name`)).rows;
  await p.query(`DELETE FROM courses`);
  await p.query(`DELETE FROM roles`); // the first course, its concepts and its sources go with the role
  const withTax = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  assert.equal((await buildCourse(deps(p, withTax.urls, fakeModel({ mapAnswers: MAPS })), withTax.courseId)).ok, true);
  assert.equal(without, 6);
  assert.equal((await privateConcepts(p, withTax.courseId)).length, 4, 'two sox phrasings became one, oracle and workday became one');
  assert.deepEqual((await p.query(`SELECT name, mentions FROM role_concepts WHERE visibility = 'shared' ORDER BY name`)).rows, shared);
});

db('a role with no taxonomy, or a taxonomy for another role, is built exactly as before', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'some-other-role', { ...TAX, role: 'some other role' });
  const x = deps(p, c.urls, fakeModel({ mapAnswers: MAPS }));
  assert.equal((await buildCourse(x, c.courseId)).ok, true);
  assert.ok(!x.chat.labels.includes('taxmap'));
  assert.equal((await privateConcepts(p, c.courseId)).length, 6);
});

db('if the mapper cannot be reached the build still succeeds with the concepts as they were', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  const x = deps(p, c.urls, fakeModel({ mapAnswers: MAPS, override: (label) => { if (label === 'taxmap') throw new Error('down'); return undefined; } }));
  const r = await buildCourse(x, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const names = (await privateConcepts(p, c.courseId)).map((r) => r.name);
  assert.ok(names.includes('sox controls documentation') && names.includes('document controls for sox compliance'));
});

db('building again with a different mapping leaves no stale private concept behind', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  await importTaxonomy(p, 'backend-engineer', TAX);
  const first = fakeModel({ mapAnswers: MAPS, override: (label) => (label === 'qa' ? 'not json' : undefined) });
  assert.equal((await buildCourse(deps(p, c.urls, first), c.courseId)).ok, false);
  await requeueBuild(p, c.courseId, () => NOW);
  // the second build maps nothing, so the two sox phrasings come back as concepts of their own and the merged one must not linger
  assert.equal((await buildCourse(deps(p, c.urls, fakeModel()), c.courseId)).ok, true);
  const names = (await privateConcepts(p, c.courseId)).map((r) => r.name);
  assert.ok(!names.includes('compliance, controls and risk'), names.join(' | '));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'private' AND id NOT IN (SELECT concept_id FROM course_concepts)`)).rows[0].n, 0);
});

db('a concept whose own name the mapper cannot place is placed by the phrasings it gathers, so a group named after a vendor still becomes the skill', async (p) => {
  const paste = postingText(['oracle ebs setup', 'workday setup', 'sql'], []);
  const c = await privateCourse(p, { pasted: paste });
  await importTaxonomy(p, 'backend-engineer', TAX);
  const x = deps(p, c.urls, fakeModel({
    override: (label, m) => (label === 'merge' && m.at(-1)!.content.includes('oracle ebs setup') ? JSON.stringify({ groups: [{ name: 'erp tooling', variants: ['oracle ebs setup', 'workday setup'] }] }) : undefined),
  }));
  const built = await buildCourse(x, c.courseId);
  assert.equal(built.ok, true);
  const rows = await privateConcepts(p, c.courseId);
  const erp = rows.find((r) => r.name === 'enterprise systems analysis')!;
  assert.ok(erp, rows.map((r) => r.name).join(' | '));
  assert.deepEqual([...erp.tools].sort(), ['Oracle', 'Workday']);
  assert.ok(!rows.some((r) => r.name === 'erp tooling'));
  assert.ok(built.notes.some((n) => /erp tooling -> enterprise systems analysis/.test(n)), built.notes.join(' | '));
});

db('"sox controls documentation" is filed under compliance with "document controls for sox compliance", not under requirements documentation because it ends in the word documentation', async (p) => {
  const c = await privateCourse(p, { pasted: PASTE_DUP });
  const tax: Taxonomy = { ...TAX, categories: TAX.categories.map((k) => (k.id === 'compliance-controls' ? { ...k, aliases: ['sox'] } : k.id === 'requirements-analysis-documentation' ? { ...k, aliases: ['documentation'] } : k)) };
  await importTaxonomy(p, 'backend-engineer', tax);
  // the aliases alone would put the first phrase under requirements documentation (the first category listed that it names): the model decides
  const x = deps(p, c.urls, fakeModel({ mapAnswers: { 'sox controls documentation': { category: 'compliance-controls', also: 'requirements-analysis-documentation' }, 'document controls for sox compliance': { category: 'compliance-controls' } } }));
  const built = await buildCourse(x, c.courseId);
  assert.equal(built.ok, true);
  const rows = await privateConcepts(p, c.courseId);
  const compliance = rows.find((r) => r.name === 'compliance, controls and risk')!;
  assert.deepEqual([...compliance.terms].sort(), ['document controls for sox compliance', 'sox controls documentation']);
  assert.ok(!rows.some((r) => r.name === 'requirements analysis and documentation'), 'and it did not start a documentation concept of its own');
});
