// Plan 16, phase 2, step 7: reading a chapter marks it read, keeps the reader active, and enrols them (spec 16, section 5).
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, privateCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createVersionStore } from './versions.ts';

const { h, ct, people, get, post, DAY, settings } = useCourseHttp('progress');
const readUrl = (courseId: string, chapterId: string) => `/courses/${courseId}/chapters/${chapterId}/read`;
const marks = (accountId: string) => h.rows(`SELECT chapter_id FROM course_progress WHERE account_id = $1`, [accountId]);

ct('Scenario: reading a chapter marks it read, once, and the course home shows it', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal((await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!))).statusCode, 204, 'idempotent');
  assert.equal((await marks(alice.id)).length, 1);
  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(home.progress, { read: 1, total: 6 });
  assert.equal(home.sections[0].chapters[0].read, true);
});

ct('reading enrols a reader who had not joined, and keeps them active', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE account_id = $1`, [alice.id]))[0].count, '0');
  await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!));
  const first = (await h.rows(`SELECT last_active_at FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, c.courseId]))[0];
  assert.equal(first.last_active_at.toISOString(), h.clock.now.toISOString());
  h.clock.now = new Date(h.clock.now.getTime() + 3 * DAY);
  await post(alice.token, readUrl(c.courseId, c.chapterIds[1]!));
  const later = (await h.rows(`SELECT last_active_at FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, c.courseId]))[0];
  assert.equal(later.last_active_at.toISOString(), h.clock.now.toISOString(), 'each read keeps the reader active');
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE account_id = $1`, [alice.id]))[0].count, '1');
});

ct('a reader who joins starts at the current version, so later updates are news to them', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!));
  assert.equal((await h.rows(`SELECT seen_version FROM course_seen WHERE account_id = $1 AND course_id = $2`, [alice.id, c.courseId]))[0].seen_version, 1);
  assert.equal((await get(alice.token, `/courses/${c.courseId}`)).json().has_updates, false);
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(c.courseId);
  await h.pool.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_added', 'A new chapter')`, [c.courseId, v2.id]);
  await versions.publish(v2.id);
  assert.equal((await get(alice.token, `/courses/${c.courseId}`)).json().has_updates, true);
});

ct('a reader already enrolled keeps their seen-version when they read', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  await h.pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 0)`, [alice.id, c.courseId]);
  await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!));
  assert.equal((await h.rows(`SELECT seen_version FROM course_seen WHERE account_id = $1`, [alice.id]))[0].seen_version, 0);
});

ct('Scenario: a chapter that is not shown, a course that is not visible, a withdrawn course and a switched-off feature are told apart', async () => {
  const { alice, bob } = await people();
  const live = await publishedCourse(h.pool);
  const other = await publishedCourse(h.pool);
  const mine = await privateCourse(h.pool, { ownerId: bob.id });
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(live.courseId);
  const unpublished = (await h.pool.query(`INSERT INTO course_chapters (section_id, position, added_in_version) VALUES ($1, 9, $2) RETURNING id`, [live.sectionIds[0], v2.id])).rows[0].id as string;
  await h.pool.query(`UPDATE course_chapters SET status = 'removed' WHERE id = $1`, [live.chapterIds[5]]);

  const notFound = [
    readUrl(live.courseId, other.chapterIds[0]!), // another course's chapter
    readUrl(live.courseId, '00000000-0000-4000-8000-000000000000'),
    readUrl(live.courseId, 'nope'),
    readUrl(live.courseId, unpublished), // added in a version that is not published
    readUrl(live.courseId, live.chapterIds[5]!), // removed
    readUrl(mine.courseId, mine.chapterId), // bob's private course
    readUrl('not-a-uuid', live.chapterIds[0]!),
  ];
  for (const url of notFound) assert.equal((await post(alice.token, url)).statusCode, 404, url);
  assert.equal((await marks(alice.id)).length, 0);

  assert.equal((await post(undefined, readUrl(live.courseId, live.chapterIds[0]!))).statusCode, 401);

  const w = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, w, { accountId: alice.id });
  const withdrawn = await post(alice.token, readUrl(w.courseId, w.chapterIds[0]!));
  assert.deepEqual([withdrawn.statusCode, withdrawn.json()], [409, { error: 'course_withdrawn' }]);

  await settings().set('courses_off', true);
  assert.deepEqual([(await post(alice.token, readUrl(live.courseId, live.chapterIds[0]!))).statusCode], [503]);
});

ct('read marks are each reader\'s own', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await post(alice.token, readUrl(c.courseId, c.chapterIds[0]!));
  await post(alice.token, readUrl(c.courseId, c.chapterIds[1]!));
  await post(bob.token, readUrl(c.courseId, c.chapterIds[2]!));
  assert.deepEqual((await get(alice.token, `/courses/${c.courseId}`)).json().progress, { read: 2, total: 6 });
  assert.deepEqual((await get(bob.token, `/courses/${c.courseId}`)).json().progress, { read: 1, total: 6 });
});
