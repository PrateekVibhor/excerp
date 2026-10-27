// Plan 16, phase 2, step 8: a reader can remove a course from their list, and deleting an account removes everything a reader did in
// courses and every private course (spec 16, section 4: "Deletion and retention"). Shared courses and shared evidence stay.
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, flagChapter, pendingCourse, privateCourse, publishedCourse } from '../../testkit/courseFixtures.ts';
import { createCourseStarts } from './starts.ts';

const { h, ct, people, get, post, DAY, settings } = useCourseHttp('coursedel');
const del = (token: string | undefined, url: string) => h.call(token, 'DELETE', url);
const count = async (sql: string, args: unknown[] = []) => Number((await h.rows(sql, args))[0].count);

ct('Scenario: removing a course from my list deletes my progress, quiz results, seen marker and input, and nothing of anyone else\'s', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id, readChapters: 3, quizBest: 2 });
  await enrolReader(h.pool, c, { accountId: bob.id, readChapters: 2, quizBest: 1 });
  await h.pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1), ($3, $2, 1)`, [alice.id, c.courseId, bob.id]);
  const flagId = await flagChapter(h.pool, c, alice.id);

  const res = await del(alice.token, `/me/courses/${c.courseId}`);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['cache-control'], 'no-store');
  for (const table of ['course_inputs', 'course_progress', 'section_quiz_results', 'course_seen']) assert.equal(await count(`SELECT count(*) FROM ${table} WHERE account_id = $1`, [alice.id]), 0, table);
  assert.equal(await count(`SELECT count(*) FROM course_inputs WHERE account_id = $1`, [bob.id]), 1, "bob's input stays");
  assert.equal(await count(`SELECT count(*) FROM course_progress WHERE account_id = $1`, [bob.id]), 2);
  assert.equal(await count(`SELECT count(*) FROM section_quiz_results WHERE account_id = $1`, [bob.id]), 1);
  assert.equal(await count(`SELECT count(*) FROM courses WHERE id = $1`, [c.courseId]), 1, 'the shared course stays');
  assert.equal(await count(`SELECT count(*) FROM course_flags WHERE id = $1`, [flagId]), 1, 'what she flagged is the owner\'s to see');
  assert.deepEqual((await get(alice.token, '/me/courses')).json(), { courses: [] });
  assert.deepEqual((await get(alice.token, `/courses/${c.courseId}`)).json().progress, { read: 0, total: 6 }, 'she can still open the course, from scratch');
});

ct('removing a course not on my list, an unknown one, signed out, or with courses off', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  assert.equal((await del(alice.token, `/me/courses/${c.courseId}`)).statusCode, 404, 'never joined');
  assert.equal((await del(alice.token, '/me/courses/00000000-0000-4000-8000-000000000000')).statusCode, 404);
  assert.equal((await del(alice.token, '/me/courses/nope')).statusCode, 404);
  await enrolReader(h.pool, c, { accountId: alice.id });
  assert.equal((await del(undefined, `/me/courses/${c.courseId}`)).statusCode, 401);
  await settings().set('courses_off', true);
  assert.equal((await del(alice.token, `/me/courses/${c.courseId}`)).statusCode, 503);
  await settings().set('courses_off', false);
  assert.equal((await del(alice.token, `/me/courses/${c.courseId}`)).statusCode, 204);
  assert.equal((await del(alice.token, `/me/courses/${c.courseId}`)).statusCode, 404, 'already gone');
});

ct('Scenario: removing a private course deletes the course, its pasted description and its own concepts, but not shared evidence', async () => {
  const { alice } = await people();
  const c = await privateCourse(h.pool, { ownerId: alice.id });
  const link = (await h.pool.query(`INSERT INTO sources (role_id, role_title, company, url, origin, found_via, match, counts_for_criticality, status) VALUES ($1, 'Product Manager', 'Acme', 'https://jobs.example.com/1', 'user_url', 'user', 'exact', true, 'current') RETURNING id`, [c.roleId])).rows[0].id as string;
  await h.pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [c.courseId, link]);

  const res = await del(alice.token, `/me/courses/${c.courseId}`);
  assert.equal(res.statusCode, 204);
  assert.equal(await count(`SELECT count(*) FROM courses WHERE id = $1`, [c.courseId]), 0);
  for (const table of ['course_versions', 'course_sections', 'course_concepts', 'course_sources']) assert.equal(await count(`SELECT count(*) FROM ${table} WHERE course_id = $1`, [c.courseId]), 0, table);
  assert.equal(await count(`SELECT count(*) FROM course_chapters WHERE id = $1`, [c.chapterId]), 0);
  assert.equal(await count(`SELECT count(*) FROM sources WHERE id = $1`, [c.pasteSourceId]), 0, 'the pasted description goes');
  assert.equal(await count(`SELECT count(*) FROM role_concepts WHERE id = $1`, [c.privateConceptId]), 0, 'the concept only her description asked for goes');
  assert.equal(await count(`SELECT count(*) FROM role_concepts WHERE id = $1`, [c.sharedConceptId]), 1, 'a shared concept stays');
  assert.equal(await count(`SELECT count(*) FROM sources WHERE id = $1`, [link]), 1, 'a shared posting stays');
});

ct('removing a pending request cancels it and removes the input, but the search stays counted', async () => {
  const { alice } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  await h.pool.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'role', now())`, [alice.id, c.courseId]);
  assert.equal((await del(alice.token, `/me/courses/${c.courseId}`)).statusCode, 204);
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [c.courseId]))[0].status, 'cancelled');
  assert.equal(await count(`SELECT count(*) FROM course_inputs WHERE account_id = $1`, [alice.id]), 0);
  assert.deepEqual(await h.rows(`SELECT kind, outcome FROM course_requests WHERE account_id = $1`, [alice.id]), [{ kind: 'source_search', outcome: 'cancelled' }]);
});

ct('Scenario: deleting an account removes everything the reader did in courses and every private course, and unlinks what must stay', async () => {
  const { alice, bob } = await people();
  const shared = await publishedCourse(h.pool);
  await enrolReader(h.pool, shared, { accountId: alice.id, readChapters: 2, quizBest: 2 });
  await enrolReader(h.pool, shared, { accountId: bob.id, readChapters: 1 });
  await h.pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1)`, [alice.id, shared.courseId]);
  await h.pool.query(`UPDATE courses SET requested_by = $2 WHERE id = $1`, [shared.courseId, alice.id]);
  await h.pool.query(`UPDATE course_runs SET requested_by = $2 WHERE course_id = $1`, [shared.courseId, alice.id]);
  const flagId = await flagChapter(h.pool, shared, alice.id, { reason: 'outdated' });
  await h.pool.query(`INSERT INTO course_requests (account_id, role_id, course_id, kind, outcome, created_at) VALUES ($1, $2, $3, 'refresh', 'started', now())`, [alice.id, shared.roleId, shared.courseId]);
  const mine = await privateCourse(h.pool, { ownerId: alice.id });
  const orphan = await pendingCourse(h.pool, { requesterId: alice.id });

  const res = await post(alice.token, '/auth/delete-account');
  assert.equal(res.statusCode, 204);

  for (const table of ['course_inputs', 'course_progress', 'section_quiz_results', 'course_seen', 'course_requests']) assert.equal(await count(`SELECT count(*) FROM ${table} WHERE account_id = $1`, [alice.id]), 0, table);
  assert.equal(await count(`SELECT count(*) FROM courses WHERE id = $1`, [mine.courseId]), 0, 'her private course');
  assert.equal(await count(`SELECT count(*) FROM sources WHERE id = $1`, [mine.pasteSourceId]), 0);
  assert.equal(await count(`SELECT count(*) FROM role_concepts WHERE id = $1`, [mine.privateConceptId]), 0);
  assert.equal(await count(`SELECT count(*) FROM courses WHERE id = $1`, [shared.courseId]), 1, 'the shared course stays');
  const kept = (await h.rows(`SELECT requested_by FROM courses WHERE id = $1`, [shared.courseId]))[0];
  assert.equal(kept.requested_by, null, 'with no link to her');
  assert.equal((await h.rows(`SELECT requested_by FROM course_runs WHERE course_id = $1`, [shared.courseId]))[0].requested_by, null);
  const f = (await h.rows(`SELECT reporter_id, snapshot FROM course_flags WHERE id = $1`, [flagId]))[0];
  assert.equal(f.reporter_id, null, 'the flag is unlinked');
  assert.match(f.snapshot, /chapter 1/, 'but its frozen text stays');
  assert.equal(await count(`SELECT count(*) FROM course_inputs WHERE account_id = $1`, [bob.id]), 1, "bob's data is untouched");
  assert.equal(await count(`SELECT count(*) FROM course_progress WHERE account_id = $1`, [bob.id]), 1);

  // Her unfinished request has no one left to approve it; it closes with the seven-day clean-up.
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [orphan.courseId]))[0].status, 'awaiting_approval');
  await h.pool.query(`UPDATE courses SET created_at = $2 WHERE id = $1`, [orphan.courseId, new Date(h.clock.now.getTime() - 8 * DAY)]);
  assert.equal(await createCourseStarts(h.pool, settings(), () => h.clock.now).expireStale(), 1);
});
