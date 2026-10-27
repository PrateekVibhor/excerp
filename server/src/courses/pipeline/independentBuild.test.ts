// Two independent lists of one reader for the same role: the builder gives each its own private concepts, so building, rebuilding or deleting one never
// changes the other. A course that is not independent keeps the old one-concept-per-name behaviour. Real SQL, fake model.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { createSources } from '../sources.ts';
import { buildCourse } from './build.ts';
import { requeueBuild } from './requeue.ts';

const { db } = useCourseDb('indepbuild', { reset: ['roles', 'accounts', 'skill_taxonomies', 'skill_categories'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const MARKET = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['python'] : [])];

/** The role, its nine market postings and the reader; lists are added to it one at a time. */
async function world(p: pg.Pool) {
  const owner = await account(p);
  const roleId = await role(p, 'backend engineer', 'Builds and runs services.');
  const sourceIds: string[] = [];
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, roleId, { status: 'current' });
    sourceIds.push(id);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { owner, roleId, sourceIds, urls };
}
/** One private list of the reader's: approved, with its own pasted description registered as its own source and a build queued. */
async function list(p: pg.Pool, w: Awaited<ReturnType<typeof world>>, pasted: string, independent: boolean) {
  const courseId = await course(p, w.roleId, { status: 'building', approved_at: NOW, title: 'backend engineer', visibility: 'private', owner_account_id: w.owner, requested_by: w.owner, independent });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  for (const id of w.sourceIds) await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'backend engineer', $3, $4)`, [w.owner, courseId, pasted, NOW]);
  const paste = await createSources(p, () => NOW).registerPaste(w.roleId, w.owner, { roleTitle: 'backend engineer' });
  await createSources(p, () => NOW).attach(courseId, paste, 'reader');
  await p.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND source_id = $2`, [courseId, paste]);
  return { courseId, versionId, paste };
}
const deps = (p: pg.Pool, urls: string[]) => ({ pool: p, chat: fakeModel(), search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(MARKET(i), [])]))), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW });
const privateRows = async (p: pg.Pool, courseId: string) =>
  (await p.query(`SELECT k.id, k.name, k.terms, k.course_id FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 AND k.visibility = 'private' ORDER BY k.name`, [courseId])).rows;

db('two independent lists of one reader each get their own private concept, even when the name is the same', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['sql', 'tableau', 'requirements analysis'], ['run a workshop']), true);
  const two = await list(p, w, postingText(['sql', 'tableau', 'requirements analysis', 'power bi'], []), true);
  assert.equal((await buildCourse(deps(p, w.urls), one.courseId)).ok, true);
  assert.equal((await buildCourse(deps(p, w.urls), two.courseId)).ok, true);
  const a = await privateRows(p, one.courseId);
  const b = await privateRows(p, two.courseId);
  assert.deepEqual(a.map((k) => k.name), ['requirements analysis', 'run a workshop', 'tableau']);
  assert.deepEqual(b.map((k) => k.name), ['power bi', 'requirements analysis', 'tableau']);
  for (const k of a) assert.equal(k.course_id, one.courseId);
  for (const k of b) assert.equal(k.course_id, two.courseId);
  const ids = new Set([...a, ...b].map((k) => k.id));
  assert.equal(ids.size, a.length + b.length, 'no concept row is shared between the two lists, so a same-named concept is two rows');
});

db('rebuilding one list does not change the other list\'s concepts', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['sql', 'tableau', 'requirements analysis'], []), true);
  const two = await list(p, w, postingText(['sql', 'tableau', 'power bi'], []), true);
  await buildCourse(deps(p, w.urls), one.courseId);
  await buildCourse(deps(p, w.urls), two.courseId);
  const before = await privateRows(p, one.courseId);
  await p.query(`UPDATE courses SET status = 'failed' WHERE id = $1`, [two.courseId]);
  await p.query(`UPDATE course_versions SET status = 'failed' WHERE course_id = $1`, [two.courseId]);
  await p.query(`UPDATE courses SET published_version = NULL WHERE id = $1`, [two.courseId]);
  await requeueBuild(p, two.courseId, () => NOW);
  await buildCourse(deps(p, w.urls), two.courseId);
  assert.deepEqual(await privateRows(p, one.courseId), before);
});

db('a course that is not independent keeps the old behaviour: one private concept per name for the reader and role', async (p) => {
  const w = await world(p);
  const only = await list(p, w, postingText(['sql', 'tableau'], []), false);
  assert.equal((await buildCourse(deps(p, w.urls), only.courseId)).ok, true);
  const rows = await privateRows(p, only.courseId);
  assert.deepEqual(rows.map((k) => [k.name, k.course_id]), [['tableau', null]], 'it carries no list, as before');
});
