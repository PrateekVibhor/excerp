// Plan 16, phase 2, step 7: a reader can flag a chapter, a concept or a quiz question as wrong (spec 16, decision 14). The flag keeps a frozen
// copy of what was flagged for the owner; three different readers put a chapter under review; nothing about a flag is shown to others.
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, pendingCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createVersionStore } from './versions.ts';

const { h, ct, people, get, post, DAY, settings } = useCourseHttp('flags');
const flag = (token: string | undefined, body: unknown) => post(token, '/me/course-flags', body);
const flagRows = (where = 'true', args: unknown[] = []) => h.rows(`SELECT * FROM course_flags WHERE ${where} ORDER BY created_at, id`, args);

ct('Scenario: flagging a chapter keeps a frozen copy of its text, the reason and the note, and thanks the reader', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await flag(alice.token, { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate', note: 'The second paragraph is wrong.' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { ok: true });
  const rows = await flagRows();
  assert.equal(rows.length, 1);
  const f = rows[0];
  assert.deepEqual([f.reporter_id, f.course_id, f.version_id, f.target_type, f.target_id, f.reason, f.note, f.status, f.action], [alice.id, c.courseId, c.versionId, 'chapter', c.chapterIds[0], 'inaccurate', 'The second paragraph is wrong.', 'open', null]);
  assert.match(f.snapshot, /Chapter 1/);
  assert.match(f.snapshot, /chapter 1/);
  assert.equal(f.created_at.toISOString(), h.clock.now.toISOString());
});

ct('flagging a concept or a question freezes that text', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await flag(alice.token, { course_id: c.courseId, target_type: 'concept', target_id: c.conceptIds[0], reason: 'outdated' });
  await flag(alice.token, { course_id: c.courseId, target_type: 'question', target_id: `${c.sectionIds[0]}:1`, reason: 'inaccurate', note: '' });
  const rows = await flagRows(); // both were made at the same instant, so find each by what it flags
  const concept = rows.find((r) => r.target_type === 'concept');
  const question = rows.find((r) => r.target_type === 'question');
  assert.match(concept.snapshot, /skill 1/);
  assert.match(concept.snapshot, /A plain explanation of skill 1\./);
  assert.match(question.snapshot, /What does key idea 2 say\?/);
  assert.match(question.snapshot, /Right 2/);
  assert.doesNotMatch(question.snapshot, /correct_index/);
});

ct('the same reader flagging the same thing the same day is one flag; the next day is another', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const body = { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate' };
  assert.equal((await flag(alice.token, body)).statusCode, 200);
  const again = await flag(alice.token, { ...body, reason: 'outdated' });
  assert.deepEqual([again.statusCode, again.json()], [200, { ok: true }], 'thanked again, nothing new stored');
  assert.equal((await flagRows()).length, 1);
  h.clock.now = new Date(h.clock.now.getTime() + DAY);
  await flag(alice.token, body);
  assert.equal((await flagRows()).length, 2);
});

ct('Scenario: three different readers put a chapter under review; two do not, and the same reader again does not count', async () => {
  const { alice, bob, carol } = await people();
  const c = await publishedCourse(h.pool);
  const body = { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate' };
  const status = async () => (await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`)).json().under_review;

  await flag(alice.token, body);
  await flag(bob.token, body);
  assert.equal(await status(), false, 'two readers');
  h.clock.now = new Date(h.clock.now.getTime() + DAY);
  await flag(alice.token, body);
  assert.equal(await status(), false, 'alice again is still two readers');
  await flag(carol.token, body);
  assert.equal(await status(), true, 'three different readers');
  assert.equal((await h.rows(`SELECT status FROM course_chapters WHERE id = $1`, [c.chapterIds[0]]))[0].status, 'under_review');
  assert.equal((await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[1]}`)).json().under_review, false, 'other chapters are untouched');
});

ct('handled flags and flags from deleted accounts do not count toward review', async () => {
  const { alice, bob, carol } = await people();
  const c = await publishedCourse(h.pool);
  const body = { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate' };
  await flag(alice.token, body);
  await flag(bob.token, body);
  await h.pool.query(`UPDATE course_flags SET status = 'handled', action = 'dismissed', handled_at = now() WHERE reporter_id = $1`, [alice.id]); // the owner dismissed one
  await flag(carol.token, body);
  assert.equal((await h.rows(`SELECT status FROM course_chapters WHERE id = $1`, [c.chapterIds[0]]))[0].status, 'live', 'two open flags');
  await h.pool.query(`UPDATE course_flags SET reporter_id = NULL WHERE reporter_id = $1`, [bob.id]); // an account that was deleted
  const dave = await h.signIn('alice'); // a new session for alice: still one reader
  await flag(dave.token, { ...body, reason: 'outdated' });
  assert.equal((await h.rows(`SELECT status FROM course_chapters WHERE id = $1`, [c.chapterIds[0]]))[0].status, 'live');
});

ct('Scenario: nothing about a flag is shown to anyone else', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await flag(alice.token, { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate', note: 'SECRET-NOTE-TEXT' });
  for (const url of [`/courses/${c.courseId}`, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`, `/courses/${c.courseId}/concepts`, `/courses/${c.courseId}/transparency`, '/me/courses']) {
    const res = await get(bob.token, url);
    assert.doesNotMatch(res.body, /SECRET-NOTE-TEXT|inaccurate|reporter/, url);
  }
});

ct('Scenario: a flag that does not fit is refused and nothing is stored', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const other = await publishedCourse(h.pool);
  const ok = { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate' };
  const bad = async (body: unknown, status: number, error: string) => {
    const res = await flag(alice.token, body);
    assert.deepEqual([res.statusCode, res.json().error], [status, error], JSON.stringify(body));
  };
  await bad(undefined, 400, 'invalid_flag');
  await bad({ ...ok, reason: 'rude' }, 400, 'invalid_flag');
  await bad({ ...ok, target_type: 'section' }, 400, 'invalid_flag');
  await bad({ ...ok, note: 'x'.repeat(501) }, 400, 'invalid_flag');
  await bad({ ...ok, note: 5 }, 400, 'invalid_flag');
  await bad({ ...ok, target_id: 7 }, 400, 'invalid_flag');
  await bad({ ...ok, course_id: undefined }, 400, 'invalid_flag');
  await bad({ ...ok, target_id: other.chapterIds[0] }, 404, 'not found'); // a chapter of another course
  await bad({ ...ok, target_id: 'nope' }, 404, 'not found');
  await bad({ ...ok, target_type: 'concept', target_id: other.conceptIds[0] }, 404, 'not found');
  await bad({ ...ok, target_type: 'question', target_id: `${c.sectionIds[0]}:3` }, 404, 'not found'); // only questions 0 to 2
  await bad({ ...ok, target_type: 'question', target_id: `${other.sectionIds[0]}:0` }, 404, 'not found');
  await bad({ ...ok, target_type: 'question', target_id: 'garbage' }, 404, 'not found');
  await bad({ ...ok, course_id: '00000000-0000-4000-8000-000000000000' }, 404, 'not found');
  assert.equal((await flagRows()).length, 0);
});

ct('only a ready course can be flagged: a pending attempt is 404, a withdrawn one 409, signed out 401, switched off 503', async () => {
  const { alice } = await people();
  const pending = await pendingCourse(h.pool, { requesterId: alice.id });
  const w = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, w, { accountId: alice.id });
  const live = await publishedCourse(h.pool);
  const attempt = (courseId: string, chapterId: string) => ({ course_id: courseId, target_type: 'chapter', target_id: chapterId, reason: 'inaccurate' });
  assert.equal((await flag(alice.token, attempt(pending.courseId, '00000000-0000-4000-8000-000000000000'))).statusCode, 404);
  const withdrawn = await flag(alice.token, attempt(w.courseId, w.chapterIds[0]!));
  assert.deepEqual([withdrawn.statusCode, withdrawn.json()], [409, { error: 'course_withdrawn' }]);
  assert.equal((await flag(undefined, attempt(live.courseId, live.chapterIds[0]!))).statusCode, 401);
  await settings().set('courses_off', true);
  assert.deepEqual([(await flag(alice.token, attempt(live.courseId, live.chapterIds[0]!))).statusCode], [503]);
});

ct('Scenario: a reader may make ten flags a day; the next is refused with the time to try again', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await settings().set('limit.flags_per_day', 2);
  const f = (i: number) => flag(alice.token, { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[i], reason: 'outdated' });
  assert.equal((await f(0)).statusCode, 200);
  h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
  assert.equal((await f(1)).statusCode, 200);
  const third = await f(2);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error, 'flag_limit');
  assert.equal(third.json().retry_at, new Date(h.clock.now.getTime() - 3_600_000 + DAY).toISOString(), 'when the first flag ages out');
  assert.equal((await flagRows()).length, 2);
  assert.equal((await f(0)).statusCode, 200, 'a repeat of today\'s flag is thanked, not counted');
});

ct('the frozen copy does not change when the chapter is rewritten and published later', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await flag(alice.token, { course_id: c.courseId, target_type: 'chapter', target_id: c.chapterIds[0], reason: 'inaccurate' });
  const before = (await flagRows())[0].snapshot;
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(c.courseId);
  await h.pool.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Rewritten', 'Completely new words.')`, [c.chapterIds[0], v2.id]);
  await versions.publish(v2.id);
  const after = (await flagRows())[0];
  assert.equal(after.snapshot, before);
  assert.equal(after.version_id, c.versionId, 'and it remembers which version was flagged');
});
