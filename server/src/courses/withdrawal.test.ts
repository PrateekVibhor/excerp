// Plan 16, phase 2, step 8: withdrawing a course end to end (spec 16, section 4, "Withdrawal"). Readers see a notice and no content, new
// readers cannot start it, refresh is paused, it is never deleted, and a corrected course that passes the checks republishes by itself.
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, publishedCourse } from '../../testkit/courseFixtures.ts';
import { createCourseModeration, type CourseChecker } from './courseModeration.ts';
import { runCourseCleanup } from './retention.ts';
import { createVersionStore } from './versions.ts';

const { h, ct, people, get, post, settings } = useCourseHttp('withdrawal');
const pass: CourseChecker = async () => ({ ok: true, reasons: [] });
const fail: CourseChecker = async () => ({ ok: false, reasons: ['a claim about law has no supporting source'] });
const owner = (checker?: CourseChecker) => createCourseModeration(h.pool, { checker, now: () => h.clock.now });
const NOTE = 'This course is being corrected.';

ct('Scenario: after a withdrawal readers see the notice and their progress and no content, and the course is not in anyone else\'s hands', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool, { roleName: 'compliance officer' });
  await enrolReader(h.pool, c, { accountId: alice.id, readChapters: 2 });
  assert.equal(await owner().withdraw(c.courseId, NOTE, 'wrong advice'), 'ok');

  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual([home.status, home.withdrawal.note, home.progress], ['withdrawn', NOTE, { read: 2, total: 6 }]);
  assert.equal(home.sections, undefined, 'no content');
  for (const url of [`/courses/${c.courseId}/chapters/${c.chapterIds[0]}`, `/courses/${c.courseId}/concepts`, `/courses/${c.courseId}/changes`]) assert.equal((await get(alice.token, url)).statusCode, 409, url);
  assert.equal((await post(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}/read`)).statusCode, 409);
  assert.equal((await get(alice.token, '/me/courses')).json().courses[0].status, 'withdrawn');
  // Someone who never joined cannot even see it, and cannot start a new one for the role.
  assert.equal((await get(bob.token, `/courses/${c.courseId}`)).statusCode, 404);
  const again = await post(bob.token, '/courses', { role: 'compliance officer' });
  assert.deepEqual([again.statusCode, again.json()], [409, { error: 'course_withdrawn' }]);
  assert.equal((await h.rows(`SELECT count(*) FROM courses WHERE role_id = $1`, [c.roleId]))[0].count, '1', 'nothing was queued');
});

ct('refresh is paused for a withdrawn course, whether a reader asks or a build tries to publish', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const building = await versions.start(c.courseId); // a refresh was already being built
  await owner().withdraw(c.courseId, NOTE, '');
  assert.equal((await post(alice.token, `/courses/${c.courseId}/refresh`)).statusCode, 409);
  await assert.rejects(versions.publish(building.id), (e: { code?: string }) => e.code === 'withdrawn');
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [c.courseId]))[0].status, 'withdrawn');
});

ct('Scenario: a withdrawn course is never deleted, whatever time passes, and a reader who removes it from their list leaves the rest alone', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  await enrolReader(h.pool, c, { accountId: bob.id });
  await owner().withdraw(c.courseId, NOTE, '');
  await h.advance(400); // the clock and every session move together
  await runCourseCleanup(h.pool, settings(), h.clock.now);
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [c.courseId]))[0].status, 'withdrawn');
  assert.equal((await h.call(alice.token, 'DELETE', `/me/courses/${c.courseId}`)).statusCode, 204);
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [c.courseId]))[0].status, 'withdrawn');
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE course_id = $1`, [c.courseId]))[0].count, '1');
});

ct('Scenario: the owner corrects the course; when the checks pass it republishes by itself and the notice clears', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool, { roleName: 'compliance officer' });
  await enrolReader(h.pool, c, { accountId: alice.id, readChapters: 1 });
  await owner().withdraw(c.courseId, NOTE, 'wrong advice');
  await owner().editChapter(c.chapterIds[0]!, 'Corrected: the filing date is the fifteenth.');

  const first = await owner(fail).markCorrected(c.courseId);
  assert.equal(first.kind, 'checks_failed');
  assert.equal((await get(alice.token, `/courses/${c.courseId}`)).json().status, 'withdrawn', 'a failing check leaves it withdrawn');

  const second = await owner(pass).markCorrected(c.courseId);
  assert.equal(second.kind, 'published');
  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.equal(home.status, 'ready');
  assert.equal(home.withdrawal, undefined, 'the notice is cleared');
  assert.equal(home.progress.read, 1, 'her progress is kept');
  const ch = (await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`)).json();
  assert.match(ch.body, /filing date is the fifteenth/);
  // The correction is news to the readers who had the course.
  const changes = (await get(alice.token, `/courses/${c.courseId}/changes?since=1`)).json();
  assert.deepEqual(changes.changes.map((x: { kind: string }) => x.kind), ['chapter_corrected']);
  // And a new reader can start the role's course again, which now exists.
  const bob = await h.signIn('bob');
  const again = await post(bob.token, '/courses', { role: 'compliance officer' });
  assert.deepEqual([again.statusCode, again.json().existing], [200, true]);
});

ct('the moderation log records the withdrawal, the edit, the failed attempt and the republish, in order, with no reader named', async () => {
  const c = await publishedCourse(h.pool);
  await h.pool.query('TRUNCATE moderation_log');
  await owner().withdraw(c.courseId, NOTE, 'wrong advice');
  await owner().editChapter(c.chapterIds[0]!, 'Corrected.');
  await owner(fail).markCorrected(c.courseId);
  await owner(pass).markCorrected(c.courseId);
  const entries = await h.rows(`SELECT action, actor, account_id, public_id FROM moderation_log ORDER BY id`);
  assert.deepEqual(entries.map((e) => e.action), ['course_withdraw', 'course_edit_chapter', 'course_correction_failed', 'course_correction_published']);
  assert.ok(entries.every((e) => e.actor === 'owner' && e.account_id === null && e.public_id === null));
});
