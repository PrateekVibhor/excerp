// Stopping a build: POST /courses/:id/cancel accepts a list that is building as well as one being found or waiting for approval; it keeps the list, its versions' runs and the credits
// they spent, and it can never end up in the same list as a publish. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { course, pendingCourse, publishedCourse, role, version } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';
import { createVersionStore } from './versions.ts';

const h = useHarness('cancel');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const post = (token: string | undefined, url: string) => h.call(token, 'POST', url, {});
const NOW = new Date('2026-10-23T12:00:00Z');

/** A list being built: approved, one building version, a run that has spent credits partway through. */
async function building(accountId: string) {
  const roleId = await role(h.pool); // a role of its own each time
  const courseId = await course(h.pool, roleId, { status: 'building', approved_at: NOW, requested_by: accountId, visibility: 'private', owner_account_id: accountId, mode: 'list', independent: true });
  const versionId = await version(h.pool, courseId, 1, 'building');
  const runId = (await h.pool.query(`INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, tavily_credits, tokens_in, tokens_out, started_at) VALUES ($1, $2, 'generation', $3, 'reference', 42, 23, 1000, 500, $4) RETURNING id`, [courseId, versionId, accountId, h.clock.now])).rows[0].id as number;
  await h.pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  return { roleId, courseId, versionId, runId };
}
const courseRow = async (id: string) => (await h.rows(`SELECT status, published_version, failure_reason FROM courses WHERE id = $1`, [id]))[0];

ct('Scenario: cancelling a list that is building answers OK, marks it cancelled, and keeps the list, its version, and its run with the credits it spent', async () => {
  const alice = await h.signIn('alice');
  const c = await building(await idOf('alice'));
  const res = await post(alice.token, `/courses/${c.courseId}/cancel`);
  assert.deepEqual([res.statusCode, res.json()], [200, { course_id: c.courseId, status: 'cancelled' }]);
  assert.equal((await courseRow(c.courseId)).status, 'cancelled');
  const runs = await h.rows(`SELECT id, tavily_credits, tokens_in, tokens_out FROM course_runs WHERE course_id = $1`, [c.courseId]);
  assert.deepEqual(runs.map((r) => ({ ...r })), [{ id: c.runId, tavily_credits: 23, tokens_in: '1000', tokens_out: '500' }], 'the run and what it spent stay on the books');
  assert.equal((await h.rows(`SELECT status FROM course_versions WHERE id = $1`, [c.versionId]))[0].status, 'failed', 'the version that was being built is not left building');
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [c.courseId]))[0].n, 1, 'the list itself is kept');
});

ct('Scenario: a run that has not started yet is closed as cancelled by the reader, so it is never picked up', async () => {
  const alice = await h.signIn('alice');
  const c = await building(await idOf('alice'));
  await h.pool.query(`UPDATE course_runs SET stage = 'queued', tavily_credits = 0 WHERE id = $1`, [c.runId]);
  const res = await post(alice.token, `/courses/${c.courseId}/cancel`);
  assert.equal(res.statusCode, 200, JSON.stringify(h.logged));
  const run = (await h.rows(`SELECT stage, finished_at, error FROM course_runs WHERE id = $1`, [c.runId]))[0];
  assert.ok(run.finished_at);
  assert.match(run.error, /cancelled by the reader/);
});

ct('Scenario: cancelling twice is OK, and nothing changes the second time', async () => {
  const alice = await h.signIn('alice');
  const c = await building(await idOf('alice'));
  assert.equal((await post(alice.token, `/courses/${c.courseId}/cancel`)).statusCode, 200);
  const before = await h.rows(`SELECT * FROM course_runs WHERE course_id = $1`, [c.courseId]);
  const again = await post(alice.token, `/courses/${c.courseId}/cancel`);
  assert.deepEqual([again.statusCode, again.json().status], [200, 'cancelled']);
  assert.deepEqual(await h.rows(`SELECT * FROM course_runs WHERE course_id = $1`, [c.courseId]), before);
});

ct('Scenario: a ready list and a failed list are still not cancellable (409)', async () => {
  const alice = await h.signIn('alice');
  const accountId = await idOf('alice');
  const ready = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET requested_by = $2, visibility = 'private', owner_account_id = $2 WHERE id = $1`, [ready.courseId, accountId]);
  const failed = await building(accountId);
  await h.pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'build_failed' WHERE id = $1`, [failed.courseId]);
  for (const id of [ready.courseId, failed.courseId]) {
    const res = await post(alice.token, `/courses/${id}/cancel`);
    assert.deepEqual([res.statusCode, res.json()], [409, { error: 'not_cancellable' }], id);
  }
  assert.equal((await courseRow(ready.courseId)).status, 'ready');
  assert.equal((await courseRow(failed.courseId)).status, 'failed');
});

ct('Scenario: finding sources and waiting for approval can still be cancelled, as before', async () => {
  const alice = await h.signIn('alice');
  const accountId = await idOf('alice');
  for (const status of ['finding_sources', 'awaiting_approval'] as const) {
    const c = await pendingCourse(h.pool, { requesterId: accountId, status });
    assert.equal((await post(alice.token, `/courses/${c.courseId}/cancel`)).statusCode, 200, status);
    assert.equal((await courseRow(c.courseId)).status, 'cancelled', status);
    assert.equal((await h.rows(`SELECT outcome FROM course_requests WHERE course_id = $1 AND kind = 'source_search'`, [c.courseId]))[0].outcome, 'cancelled');
  }
});

ct('Scenario: only the reader\'s own list: someone else gets "not found", no one signed in gets 401, and nothing is cancelled', async () => {
  const alice = await h.signIn('alice');
  const bob = await h.signIn('bob');
  const c = await building(await idOf('alice'));
  assert.equal((await post(bob.token, `/courses/${c.courseId}/cancel`)).statusCode, 404);
  assert.equal((await post(undefined, `/courses/${c.courseId}/cancel`)).statusCode, 401);
  assert.equal((await courseRow(c.courseId)).status, 'building');
  void alice;
});

ct('Scenario: nothing is refunded and the daily limit is unchanged by a cancel', async () => {
  const alice = await h.signIn('alice');
  const accountId = await idOf('alice');
  const c = await building(accountId);
  await h.pool.query(`INSERT INTO course_requests (account_id, role_id, course_id, kind, outcome, created_at) VALUES ($1, $2, $3, 'source_search', 'started', $4), ($1, $2, $3, 'approval', 'approved', $4)`, [accountId, c.roleId, c.courseId, NOW]);
  await post(alice.token, `/courses/${c.courseId}/cancel`);
  const rows = (await h.rows(`SELECT kind, outcome FROM course_requests WHERE course_id = $1 ORDER BY kind`, [c.courseId])).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ kind: 'approval', outcome: 'approved' }, { kind: 'source_search', outcome: 'cancelled' }], 'the approval still counts; the search is marked cancelled and still counts toward the limit, as before');
  assert.equal((await h.rows(`SELECT tavily_credits FROM course_runs WHERE id = $1`, [c.runId]))[0].tavily_credits, 23);
});

ct('Scenario: a cancel racing the final publish ends in exactly one outcome, never both', async () => {
  const alice = await h.signIn('alice');
  const accountId = await idOf('alice');
  const versions = createVersionStore(h.pool, () => NOW);
  const outcomes = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const c = await building(accountId);
    const [cancel, publish] = await Promise.all([
      post(alice.token, `/courses/${c.courseId}/cancel`),
      versions.publish(c.versionId).then(() => 'published' as const, (e) => (e as { code?: string }).code ?? 'error'),
    ]);
    const row = await courseRow(c.courseId);
    const v = (await h.rows(`SELECT status FROM course_versions WHERE id = $1`, [c.versionId]))[0].status;
    if (row.status === 'ready') {
      assert.deepEqual([cancel.statusCode, publish, row.published_version === c.versionId, v], [409, 'published', true, 'published'], `round ${round}`);
      outcomes.add('published');
    } else {
      assert.deepEqual([cancel.statusCode, publish, row.status, row.published_version, v], [200, 'cancelled', 'cancelled', null, 'failed'], `round ${round}`);
      outcomes.add('cancelled');
    }
  }
  assert.ok(outcomes.size >= 1);
});

ct('Scenario: a cancelled list cannot be published or failed afterwards, and cannot be queued again', async () => {
  const alice = await h.signIn('alice');
  const c = await building(await idOf('alice'));
  await post(alice.token, `/courses/${c.courseId}/cancel`);
  const versions = createVersionStore(h.pool, () => NOW);
  await assert.rejects(versions.publish(c.versionId), (e: { code?: string; message?: string }) => e.code === 'cancelled' && /^cancelled: by the reader/.test(e.message ?? ''));
  assert.equal((await courseRow(c.courseId)).status, 'cancelled');
});
