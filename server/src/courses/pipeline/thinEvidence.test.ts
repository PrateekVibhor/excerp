// Thin evidence for an independent business analyst list: it needs only one usable source in all (the reader's own pasted posting counts as that), so it builds even when few or
// no similar postings were found; it is marked thin below eight postings, shows no market badges, and never writes its small pool's numbers onto the role's shared concepts.
// Every other course (a shared list, a narrative course, product manager and forward-deployed engineer) keeps its minimum of eight. Real SQL, fake model.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, concept, course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { createSources } from '../sources.ts';
import { buildCourse } from './build.ts';

const { db } = useCourseDb('thinevid', { reset: ['roles', 'accounts', 'skill_taxonomies', 'skill_categories'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const MARKET = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['python'] : [])];
const PASTE = postingText(['sql', 'tableau', 'requirements analysis'], ['run a workshop']);

/** An approved private list of one reader, with `market` similar postings and (unless `pasted` is null) the reader's own pasted posting registered as its source. */
async function setup(p: pg.Pool, o: { market: number; independent?: boolean; pasted?: string | null; shared?: boolean }) {
  const owner = await account(p);
  const roleId = await role(p, 'business analyst', 'Works out what a business needs.');
  const privateList = !o.shared;
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'business analyst', mode: 'list', visibility: privateList ? 'private' : 'shared', ...(privateList ? { owner_account_id: owner } : {}), requested_by: owner, independent: o.independent ?? true });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < o.market; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  if (privateList) {
    const pasted = o.pasted === undefined ? PASTE : o.pasted;
    await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'business analyst', $3, $4)`, [owner, courseId, pasted, NOW]);
    const paste = await createSources(p, () => NOW).registerPaste(roleId, owner, { roleTitle: 'business analyst' });
    await createSources(p, () => NOW).attach(courseId, paste, 'reader');
    await p.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND source_id = $2`, [courseId, paste]);
  }
  return { owner, roleId, courseId, versionId, urls };
}
const deps = (p: pg.Pool, urls: string[]) => ({ pool: p, chat: fakeModel(), search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(MARKET(i), [])]))), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW });
const course_ = async (p: pg.Pool, id: string) => (await p.query(`SELECT status, failure_reason, pool_size, evidence_thin FROM courses WHERE id = $1`, [id])).rows[0];
const conceptsOf = async (p: pg.Pool, courseId: string) =>
  (await p.query(`SELECT k.name, k.visibility, k.course_id, k.mentions, k.criticality, cc.from_reader_source AS own FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY k.name`, [courseId])).rows;

db('with no similar posting found at all, the reader\'s own posting is enough: the list builds from it, marked thin, every concept the reader\'s own and private to the list', async (p) => {
  const c = await setup(p, { market: 0 });
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(await course_(p, c.courseId), { status: 'ready', failure_reason: null, pool_size: 0, evidence_thin: true });
  const concepts = await conceptsOf(p, c.courseId);
  assert.ok(concepts.length >= 3);
  for (const k of concepts) assert.deepEqual([k.visibility, k.course_id, k.own, k.criticality, k.mentions], ['private', c.courseId, true, null, 0], k.name);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'shared'`)).rows[0].n, 0, 'nothing was added to the role\'s shared concepts');
});

db('with a few similar postings it builds, marked thin with their number, shows no market badge, and leaves the role\'s shared concepts exactly as they were', async (p) => {
  const c = await setup(p, { market: 3 });
  await concept(p, c.roleId, 'sql', { mentions: 17, of_postings: 17, criticality: 'high', terms: JSON.stringify(['sql']) });
  const before = (await p.query(`SELECT name, mentions, of_postings, criticality, terms FROM role_concepts WHERE visibility = 'shared' ORDER BY name`)).rows;
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(await course_(p, c.courseId), { status: 'ready', failure_reason: null, pool_size: 3, evidence_thin: true });
  assert.deepEqual((await p.query(`SELECT name, mentions, of_postings, criticality, terms FROM role_concepts WHERE visibility = 'shared' ORDER BY name`)).rows, before, 'the 17-posting numbers of the shared concept are not overwritten by a 3-posting pool');
  const concepts = await conceptsOf(p, c.courseId);
  const sql = concepts.find((k) => k.name === 'sql')!;
  assert.equal(sql.visibility, 'shared', 'a concept the role already has is used as it is');
  const debugging = concepts.find((k) => k.name === 'debugging')!; // two of the three similar postings ask for it, and the role did not have it
  assert.deepEqual([debugging.visibility, debugging.course_id, debugging.criticality], ['private', c.courseId, null], 'a new concept stays private to the list, with no badge');
});

db('with eight or more postings nothing changes: not thin, and the market numbers are written as they always were', async (p) => {
  const c = await setup(p, { market: 9 });
  assert.equal((await buildCourse(deps(p, c.urls), c.courseId)).ok, true);
  assert.deepEqual(await course_(p, c.courseId), { status: 'ready', failure_reason: null, pool_size: 9, evidence_thin: false });
  const sql = (await p.query(`SELECT mentions, of_postings, criticality, visibility FROM role_concepts WHERE name = 'sql' AND visibility = 'shared'`)).rows[0];
  assert.deepEqual([sql.mentions, sql.of_postings, sql.criticality], [9, 9, 'high']);
});

db('if the reader\'s posting cannot be read but similar postings were found, the list still builds from them, thin, with a note', async (p) => {
  const c = await setup(p, { market: 3, pasted: null });
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await course_(p, c.courseId)).evidence_thin, true);
  assert.ok(r.notes.some((n) => /pasted description could not be read/.test(n)));
});

db('with nothing at all to read (no similar posting and the reader\'s own cannot be read) it fails with no_source, and the course ends failed', async (p) => {
  const c = await setup(p, { market: 0, pasted: null });
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /no_source/);
  assert.deepEqual((await course_(p, c.courseId)).status, 'failed');
  assert.equal((await course_(p, c.courseId)).failure_reason, 'no_source');
});

db('everything else keeps its minimum of eight: a list that is not independent, a shared list, and a private narrative course', async (p) => {
  for (const o of [{ market: 7, independent: false }, { market: 5, shared: true, independent: false }]) {
    const c = await setup(p, o);
    const r = await buildCourse(deps(p, c.urls), c.courseId);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(JSON.stringify(r), /not_enough_postings: \d postings remain/);
    assert.equal((await course_(p, c.courseId)).failure_reason, 'not_enough_postings');
    await p.query('TRUNCATE roles CASCADE');
  }
  const narrative = await setup(p, { market: 4, independent: false });
  await p.query(`UPDATE courses SET mode = 'narrow' WHERE id = $1`, [narrative.courseId]);
  const r = await buildCourse(deps(p, narrative.urls), narrative.courseId);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /not_enough_postings/);
});
