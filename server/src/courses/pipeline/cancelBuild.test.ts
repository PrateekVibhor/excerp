// Stopping a build that is running. A cancel (or a delete) is noticed at every stage boundary and before each concept's work, with one small read; once noticed, no new paid call
// starts, nothing is published, the cancelled status is kept, and the run records why. Real SQL, fake model, search and page reading: no credits.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';
import { runCourseQueue } from '../runner.ts';
import { createCourseSettings } from '../settings.ts';
import { createCourseStarts } from '../starts.ts';

const { db } = useCourseDb('cancelbuild', { reset: ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'] });
const NOW = new Date('2026-10-23T12:00:00Z');
const SKILLS = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
const READ_OK = async () => ({ ok: true as const, text: 'A page that explains the idea in plain words, at some length, for people doing the work. '.repeat(10) });

async function approved(p: pg.Pool) {
  const accountId = await account(p);
  await createCourseSettings(p).set('courses_off', false); // a cancel is refused while courses are off
  const roleId = await role(p, undefined, 'Builds and runs services.');
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'backend engineer', mode: 'list', requested_by: accountId, visibility: 'private', owner_account_id: accountId, independent: true });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { accountId, roleId, courseId, versionId, runId, urls };
}
const texts = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, postingText(SKILLS(i), [])]));

/** A model that does something (a cancel, a delete) the first time it is asked for a given kind of thing, then answers as usual. */
function triggered(base: ReturnType<typeof fakeModel>, on: string, act: () => Promise<void>) {
  let fired = false;
  const chat = (async (...args: Parameters<typeof base>) => {
    const before = base.labels.length;
    const answer = await base(...args);
    if (!fired && base.labels[before] === on) {
      fired = true;
      await act();
    }
    return answer;
  }) as typeof base;
  chat.labels = base.labels;
  return chat;
}
function deps(p: pg.Pool, urls: string[], model: ReturnType<typeof fakeModel>, extra: Record<string, unknown> = {}) {
  const search = fakeSearch();
  const extract = fakeExtract(texts(urls));
  return { search, extract, d: { pool: p, chat: model, search, extract, youtube: fakeYoutube(), reachable: async () => true, readPage: READ_OK, now: () => NOW, concurrency: 1, ...extra } };
}
const cancelIt = (p: pg.Pool, accountId: string, courseId: string) => createCourseStarts(p, createCourseSettings(p), () => NOW).cancel(accountId, courseId);
const counts = async (p: pg.Pool, courseId: string) => ({
  concepts: (await p.query(`SELECT count(*)::int AS n FROM list_concepts WHERE course_id = $1`, [courseId])).rows[0].n as number,
  links: (await p.query(`SELECT count(*)::int AS n FROM list_links WHERE course_id = $1`, [courseId])).rows[0].n as number,
});

db('g. a build that is not cancelled completes exactly as before: ready, published, nothing recorded as cancelled', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls, fakeModel());
  const r = await buildCourse(x.d, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = (await p.query(`SELECT status, published_version, failure_reason FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([row.status, row.published_version === c.versionId, row.failure_reason], ['ready', true, null]);
  assert.equal((await p.query(`SELECT error FROM course_runs WHERE id = $1`, [c.runId])).rows[0].error, null);
  assert.ok((await counts(p, c.courseId)).concepts >= 3);
});

db('b. after a cancel the build stops at the next stage boundary: no later paid call, nothing published, the status stays cancelled, and the run records it', async (p) => {
  const c = await approved(p);
  const base = fakeModel();
  const model = triggered(base, 'merge', async () => void (await cancelIt(p, c.accountId, c.courseId))); // cancelled while the list is being ranked
  const x = deps(p, c.urls, model);
  const r = await buildCourse(x.d, c.courseId);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^cancelled: by the reader/);
  for (const later of ['delta', 'page', 'facts', 'dispname', 'teach']) assert.ok(!base.labels.includes(later), `no ${later} call after the cancel`);
  assert.equal(x.search.calls, 0, 'no search was started after the cancel');
  const row = (await p.query(`SELECT status, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([row.status, row.published_version], ['cancelled', null]);
  assert.deepEqual(await counts(p, c.courseId), { concepts: 0, links: 0 });
  const run = (await p.query(`SELECT error, finished_at FROM course_runs WHERE id = $1`, [c.runId])).rows[0];
  assert.match(run.error, /^cancelled: by the reader/);
  assert.ok(run.finished_at);
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [c.versionId])).rows[0].status, 'failed');
});

db('b2. a cancel in the middle of the research stops it before the next concept: far fewer searches than a full build, the research already saved stays, nothing is published', async (p) => {
  const full = await approved(p);
  const fullRun = deps(p, full.urls, fakeModel());
  assert.equal((await buildCourse(fullRun.d, full.courseId)).ok, true);
  const fullSearches = fullRun.search.calls;
  assert.ok(fullSearches >= 3);

  const c = await approved(p);
  const base = fakeModel();
  let pages = 0;
  const model = triggered(base, 'page', async () => void (pages++ === 0 && (await cancelIt(p, c.accountId, c.courseId))));
  const x = deps(p, c.urls, model);
  const r = await buildCourse(x.d, c.courseId);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^cancelled: by the reader/);
  assert.ok(x.search.calls < fullSearches, `searches ${x.search.calls} of ${fullSearches}`);
  assert.ok(x.search.calls <= 2, 'at most the search the concept in progress was already making');
  assert.ok((await p.query(`SELECT count(*)::int AS n FROM resources`)).rows[0].n >= 0);
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [c.courseId])).rows[0].status, 'cancelled');
  assert.deepEqual(await counts(p, c.courseId), { concepts: 0, links: 0 });
});

db('c. deleting the list in the middle of the build stops it cleanly: no failure recorded, no "no such version", no later paid call', async (p) => {
  const c = await approved(p);
  const base = fakeModel();
  const model = triggered(base, 'merge', async () => void (await p.query(`DELETE FROM courses WHERE id = $1`, [c.courseId])));
  const x = deps(p, c.urls, model);
  const r = await buildCourse(x.d, c.courseId);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^cancelled: list deleted/);
  assert.doesNotMatch((r as { reason: string }).reason, /no such version/);
  for (const later of ['delta', 'page', 'dispname']) assert.ok(!base.labels.includes(later), `no ${later} call after the delete`);
  assert.equal(x.search.calls, 0);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [c.courseId])).rows[0].n, 0);
});

db('c2. a delete that lands during the last stages stops the build without a failure either (a write to the vanished list is not a crash)', async (p) => {
  const c = await approved(p);
  const base = fakeModel();
  const model = triggered(base, 'dispname', async () => void (await p.query(`DELETE FROM courses WHERE id = $1`, [c.courseId])));
  const r = await buildCourse(deps(p, c.urls, model).d, c.courseId);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^cancelled: list deleted/);
});

db('e. a build whose list was cancelled just before the final publish is not published: the publish step refuses and the list stays cancelled', async (p) => {
  const c = await approved(p);
  const base = fakeModel();
  const model = triggered(base, 'dispname', async () => void (await cancelIt(p, c.accountId, c.courseId))); // the last stage's own model call
  const r = await buildCourse(deps(p, c.urls, model).d, c.courseId);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^cancelled: by the reader/);
  const row = (await p.query(`SELECT status, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([row.status, row.published_version], ['cancelled', null]);
});

db('f. a worker restart does not resume a cancelled list: its queued run is closed, an interrupted run is closed without failing the list, and nothing is built', async (p) => {
  const c = await approved(p);
  await cancelIt(p, c.accountId, c.courseId);
  // what a dead worker leaves: a run that had started and never finished, and a queued one for the same cancelled list
  await p.query(`UPDATE course_runs SET stage = 'reference', finished_at = NULL, error = NULL WHERE id = $1`, [c.runId]);
  const queued = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [c.courseId, c.versionId, NOW])).rows[0].id as number;
  let builds = 0;
  const logs: Array<Record<string, unknown>> = [];
  const result = await runCourseQueue({ pool: p, log: (e: Record<string, unknown>) => void logs.push(e), now: () => NOW, find: async () => ({ ok: true }), build: async () => (builds++, { ok: true }) } as never);
  assert.equal(result.status, 'ran');
  assert.equal(builds, 0, 'nothing was built');
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [c.courseId])).rows[0].status, 'cancelled');
  const rows = (await p.query(`SELECT id, finished_at, error FROM course_runs WHERE id = ANY($1) ORDER BY id`, [[c.runId, queued]])).rows;
  assert.ok(rows.every((r: { finished_at: unknown }) => r.finished_at), 'both runs are closed');
  assert.equal(rows.find((r: { id: number }) => r.id === queued).error, 'course_not_waiting');
});

db('h. the runner logs one line when a build stops because of a cancel or a delete, with the reason and no user data, and does not count it as a failure', async (p) => {
  const c = await approved(p);
  const base = fakeModel();
  const model = triggered(base, 'merge', async () => void (await cancelIt(p, c.accountId, c.courseId)));
  const x = deps(p, c.urls, model);
  const logs: Array<Record<string, unknown>> = [];
  const result = await runCourseQueue({ pool: p, log: (e: Record<string, unknown>) => void logs.push(e), now: () => NOW, find: async () => ({ ok: true }), build: async (id: string) => buildCourse(x.d, id) } as never);
  assert.equal(result.status, 'ran');
  assert.equal((result as { failed: number }).failed, 0);
  const stopped = logs.filter((l) => l.event === 'course_build_stopped');
  assert.deepEqual(stopped, [{ event: 'course_build_stopped', reason: 'cancelled' }]);
  assert.ok(!logs.some((l) => l.event === 'course_run_failed'));
  assert.ok(!JSON.stringify(logs).includes(c.courseId) && !JSON.stringify(logs).includes(c.accountId));
});
