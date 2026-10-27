// Plan 16, phase 2, step 7: the changelog a reader sees after an update ("what's new since you last took it"), and the marker that
// says they have seen it (spec 16, decision 22).
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, privateCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createVersionStore } from './versions.ts';

const { h, ct, people, get, post, settings } = useCourseHttp('changes');
const versions = () => createVersionStore(h.pool, () => h.clock.now);

/** Publishes a new version of the course carrying the given changes. */
async function update(courseId: string, changes: Array<{ kind: string; summary: string; target?: string }>) {
  const v = await versions().start(courseId);
  for (const c of changes) await h.pool.query(`INSERT INTO course_changes (course_id, version_id, kind, summary, target) VALUES ($1, $2, $3, $4, $5)`, [courseId, v.id, c.kind, c.summary, c.target ?? null]);
  await versions().publish(v.id);
  h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
  return v;
}

ct('Scenario: the changelog lists published changes after a version, newest first', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await update(c.courseId, [{ kind: 'concept_added', summary: 'Added "data contracts" to the course.' }]);
  await update(c.courseId, [{ kind: 'criticality_changed', summary: 'SQL moved from Medium to High.', target: 'sql' }, { kind: 'chapter_added', summary: 'A new chapter on data contracts.' }]);
  const unpublished = await versions().start(c.courseId);
  await h.pool.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_corrected', 'Not live yet.')`, [c.courseId, unpublished.id]);

  const res = await get(alice.token, `/courses/${c.courseId}/changes`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.equal(body.current_version, 3);
  assert.deepEqual(body.changes.map((x: { version: number }) => x.version), [3, 3, 2], 'newest version first');
  assert.deepEqual(Object.keys(body.changes[0]).sort(), ['id', 'kind', 'published_at', 'summary', 'target', 'version']);
  assert.ok(!JSON.stringify(body).includes('Not live yet'), 'a change in a version that is not published is hidden');

  const since2 = (await get(alice.token, `/courses/${c.courseId}/changes?since=2`)).json();
  assert.deepEqual(since2.changes.map((x: { version: number }) => x.version), [3, 3]);
  const since3 = (await get(alice.token, `/courses/${c.courseId}/changes?since=3`)).json();
  assert.deepEqual(since3.changes, []);
});

ct('a course with no changes has an empty changelog, and a bad since is refused', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  assert.deepEqual((await get(alice.token, `/courses/${c.courseId}/changes`)).json(), { current_version: 1, changes: [] });
  for (const since of ['x', '-1', '1.5', '', '99999999999999999999']) {
    const res = await get(alice.token, `/courses/${c.courseId}/changes?since=${since}`);
    assert.deepEqual([res.statusCode, res.json().error], [400, 'since must be a whole number'], since);
  }
});

ct('Scenario: seeing the changelog is remembered, never goes backwards, and ends the "updates" notice', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  await h.pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1)`, [alice.id, c.courseId]);
  await update(c.courseId, [{ kind: 'chapter_added', summary: 'A new chapter.' }]);
  await update(c.courseId, [{ kind: 'resource_replaced', summary: 'A dead link was replaced.' }]);
  const home = async () => (await get(alice.token, `/courses/${c.courseId}`)).json().has_updates;
  const seen = async () => (await h.rows(`SELECT seen_version FROM course_seen WHERE account_id = $1 AND course_id = $2`, [alice.id, c.courseId]))[0].seen_version;
  assert.equal(await home(), true);

  const one = await post(alice.token, `/me/courses/${c.courseId}/seen`, { version: 2 });
  assert.equal(one.statusCode, 204);
  assert.equal(await seen(), 2);
  assert.equal(await home(), true, 'version 3 is still news');
  assert.equal((await post(alice.token, `/me/courses/${c.courseId}/seen`, { version: 2 })).statusCode, 204, 'idempotent');
  assert.equal((await post(alice.token, `/me/courses/${c.courseId}/seen`, { version: 1 })).statusCode, 204);
  assert.equal(await seen(), 2, 'it never goes backwards');
  await post(alice.token, `/me/courses/${c.courseId}/seen`, { version: 3 });
  assert.equal(await home(), false);
  const left = (await get(alice.token, `/courses/${c.courseId}/changes?since=${await seen()}`)).json();
  assert.deepEqual(left.changes, [], 'what was seen is not shown again');
});

ct('seeing the changelog needs a whole version no later than the live one', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  const seenUrl = `/me/courses/${c.courseId}/seen`;
  for (const body of [undefined, {}, { version: 'two' }, { version: -1 }, { version: 1.5 }, { version: null }]) {
    const res = await h.call(alice.token, 'POST', seenUrl, body);
    assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_version'], JSON.stringify(body));
  }
  const ahead = await post(alice.token, seenUrl, { version: 2 });
  assert.deepEqual([ahead.statusCode, ahead.json()], [400, { error: 'version_ahead' }]);
});

ct('a reader who has not joined can mark a changelog seen, which joins them', async () => {
  const { bob } = await people();
  const c = await publishedCourse(h.pool);
  assert.equal((await post(bob.token, `/me/courses/${c.courseId}/seen`, { version: 1 })).statusCode, 204);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [bob.id, c.courseId]))[0].count, '1');
  assert.equal((await h.rows(`SELECT seen_version FROM course_seen WHERE account_id = $1`, [bob.id]))[0].seen_version, 1);
});

ct('both endpoints follow the access rules: 404, 409 for withdrawn, 401 signed out, 503 switched off', async () => {
  const { alice, bob } = await people();
  const live = await publishedCourse(h.pool);
  const mine = await privateCourse(h.pool, { ownerId: bob.id });
  const w = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, w, { accountId: alice.id });
  for (const courseId of [mine.courseId, '00000000-0000-4000-8000-000000000000', 'nope']) {
    assert.equal((await get(alice.token, `/courses/${courseId}/changes`)).statusCode, 404, courseId);
    assert.equal((await post(alice.token, `/me/courses/${courseId}/seen`, { version: 1 })).statusCode, 404, courseId);
  }
  const a = await get(alice.token, `/courses/${w.courseId}/changes`);
  const b = await post(alice.token, `/me/courses/${w.courseId}/seen`, { version: 1 });
  assert.deepEqual([a.statusCode, a.json(), b.statusCode, b.json()], [409, { error: 'course_withdrawn' }, 409, { error: 'course_withdrawn' }]);
  assert.equal((await get(undefined, `/courses/${live.courseId}/changes`)).statusCode, 401);
  assert.equal((await post(undefined, `/me/courses/${live.courseId}/seen`, { version: 1 })).statusCode, 401);
  await settings().set('courses_off', true);
  assert.equal((await get(alice.token, `/courses/${live.courseId}/changes`)).statusCode, 503);
  assert.equal((await post(alice.token, `/me/courses/${live.courseId}/seen`, { version: 1 })).statusCode, 503);
});
