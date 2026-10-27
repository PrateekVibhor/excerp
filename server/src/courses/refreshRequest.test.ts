// Plan 16, phase 2, step 7: a reader can ask for an earlier refresh (spec 16, decision 21). The request is logged and a refresh run is
// queued; the refresh itself is the pipeline's work (phase 4). Once per course per reader per 14 days.
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, pendingCourse, privateCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';

const { h, ct, people, post, DAY, settings } = useCourseHttp('refresh');
const url = (courseId: string) => `/courses/${courseId}/refresh`;
const runs = (courseId: string) => h.rows(`SELECT kind, stage, percent, requested_by, finished_at FROM course_runs WHERE course_id = $1 AND kind = 'refresh'`, [courseId]);
const advance = (ms: number) => void (h.clock.now = new Date(h.clock.now.getTime() + ms));

ct('Scenario: asking for a refresh queues a refresh run and is logged; asking again the same day is the same request', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  const first = await post(alice.token, url(c.courseId));
  assert.equal(first.statusCode, 202);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.deepEqual(first.json(), { course_id: c.courseId, status: 'queued' });
  assert.deepEqual(await runs(c.courseId), [{ kind: 'refresh', stage: 'queued', percent: 0, requested_by: alice.id, finished_at: null }]);
  assert.deepEqual(await h.rows(`SELECT kind, outcome FROM course_requests WHERE account_id = $1`, [alice.id]), [{ kind: 'refresh', outcome: 'started' }]);

  advance(2 * 3_600_000);
  const again = await post(alice.token, url(c.courseId));
  assert.deepEqual([again.statusCode, again.json()], [200, { course_id: c.courseId, status: 'queued', repeat: true }]);
  assert.equal((await runs(c.courseId)).length, 1, 'no second run');
});

ct('Scenario: once per course per reader per 14 days, with the time to try again', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  const other = await publishedCourse(h.pool);
  const start = h.clock.now.getTime();
  assert.equal((await post(alice.token, url(c.courseId))).statusCode, 202);
  advance(2 * DAY);
  const early = await post(alice.token, url(c.courseId));
  assert.equal(early.statusCode, 429);
  assert.deepEqual([early.json().error, early.json().retry_at], ['refresh_limit', new Date(start + 14 * DAY).toISOString()]);
  assert.equal((await post(alice.token, url(other.courseId))).statusCode, 202, 'another course');
  assert.equal((await post(bob.token, url(c.courseId))).statusCode, 202, 'another reader');
  advance(12 * DAY);
  assert.equal((await post(alice.token, url(c.courseId))).statusCode, 202, 'after 14 days');
});

ct('a course whose pool was checked in the last day is up to date and uses no allowance', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET last_checked_at = $2 WHERE id = $1`, [c.courseId, new Date(h.clock.now.getTime() - 3_600_000)]);
  const res = await post(alice.token, url(c.courseId));
  assert.deepEqual([res.statusCode, res.json()], [200, { course_id: c.courseId, status: 'up_to_date' }]);
  assert.equal((await runs(c.courseId)).length, 0);
  assert.deepEqual(await h.rows(`SELECT outcome FROM course_requests WHERE account_id = $1`, [alice.id]), [{ outcome: 'served_existing' }]);
});

ct('the global cap on refresh checks stops a request and says when to try again', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await settings().set('cap.refresh_checks_per_day', 1);
  await h.pool.query(`INSERT INTO course_runs (course_id, kind, stage, started_at) VALUES ($1, 'refresh', 'recheck', $2)`, [c.courseId, new Date(h.clock.now.getTime() - 5 * 3_600_000)]);
  const res = await post(alice.token, url(c.courseId));
  assert.deepEqual([res.statusCode, res.json().error], [429, 'refresh_cap']);
  assert.equal(res.json().retry_at, new Date(h.clock.now.getTime() - 5 * 3_600_000 + DAY).toISOString());
});

ct('a withdrawn course cannot be refreshed; a hidden one is 404; signed out 401; switched off 503', async () => {
  const { alice, bob } = await people();
  const w = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, w, { accountId: alice.id });
  const withdrawn = await post(alice.token, url(w.courseId));
  assert.deepEqual([withdrawn.statusCode, withdrawn.json()], [409, { error: 'course_withdrawn' }]);
  assert.equal((await runs(w.courseId)).length, 0);

  const mine = await privateCourse(h.pool, { ownerId: bob.id });
  const pending = await pendingCourse(h.pool, { requesterId: bob.id });
  for (const courseId of [mine.courseId, pending.courseId, '00000000-0000-4000-8000-000000000000', 'nope']) assert.equal((await post(alice.token, url(courseId))).statusCode, 404, courseId);
  assert.equal((await post(bob.token, url(mine.courseId))).statusCode, 202, 'the owner of a private course can');

  const live = await publishedCourse(h.pool);
  assert.equal((await post(undefined, url(live.courseId))).statusCode, 401);
  await settings().set('courses_off', true);
  assert.equal((await post(alice.token, url(live.courseId))).statusCode, 503);
});
