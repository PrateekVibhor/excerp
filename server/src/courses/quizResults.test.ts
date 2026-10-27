// Plan 16, phase 2, step 7: a section quiz is graded on the server against the published version's quiz, and the best score is kept.
import assert from 'node:assert/strict';
import { useCourseHttp } from '../../testkit/courseHttp.ts';
import { enrolReader, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createVersionStore } from './versions.ts';

const { h, ct, people, get, post, settings } = useCourseHttp('quizresults');
const url = (courseId: string, sectionId: string) => `/courses/${courseId}/sections/${sectionId}/quiz`;
// The fixture quiz: three questions, the right answers being the options at indexes 1, 2 and 3 (correct_index = n % 4 for n = 1, 2, 3).
const RIGHT = [1, 2, 3];
const result = async (accountId: string, sectionId: string) => (await h.rows(`SELECT best_score, attempts FROM section_quiz_results WHERE account_id = $1 AND section_id = $2`, [accountId, sectionId]))[0];

ct('Scenario: a right answer scores and the best score and number of attempts are kept', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const full = await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['cache-control'], 'no-store');
  assert.deepEqual(full.json(), {
    section_id: c.sectionIds[0], score: 3, total: 3, best_score: 3, attempts: 1,
    results: [{ correct: true, correct_index: 1 }, { correct: true, correct_index: 2 }, { correct: true, correct_index: 3 }],
  });

  const worse = await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: [0, 2, 0] });
  assert.deepEqual([worse.json().score, worse.json().best_score, worse.json().attempts], [1, 3, 2], 'the best score is kept');
  assert.deepEqual(worse.json().results.map((r: { correct: boolean }) => r.correct), [false, true, false]);
  assert.deepEqual(await result(alice.id, c.sectionIds[0]!), { best_score: 3, attempts: 2 });
});

ct('a better score replaces the best, and the course home shows it', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: [0, 0, 0] });
  assert.deepEqual(await result(alice.id, c.sectionIds[0]!), { best_score: 0, attempts: 1 });
  await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: [1, 2, 0] });
  assert.deepEqual(await result(alice.id, c.sectionIds[0]!), { best_score: 2, attempts: 2 });
  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(home.sections[0].quiz, { taken: true, best_score: 2 });
  assert.deepEqual(home.sections[1].quiz, { taken: false, best_score: null });
});

ct('taking a quiz keeps the reader active and enrols them', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT });
  const row = (await h.rows(`SELECT last_active_at FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, c.courseId]))[0];
  assert.equal(row.last_active_at.toISOString(), h.clock.now.toISOString());
});

ct('answers that do not fit the quiz are refused and nothing is saved', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  for (const body of [undefined, {}, { answers: 'abc' }, { answers: [1, 2] }, { answers: [1, 2, 3, 0] }, { answers: [1, 2, 4] }, { answers: [1, 2, -1] }, { answers: [1, 2, 1.5] }, { answers: [1, 2, '3'] }, { answers: [1, null, 3] }]) {
    const res = await h.call(alice.token, 'POST', url(c.courseId, c.sectionIds[0]!), body);
    assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_answers'], JSON.stringify(body));
  }
  assert.equal(await result(alice.id, c.sectionIds[0]!), undefined);
});

ct('Scenario: a quiz is graded against the published version, and a regenerated quiz takes over when it is published', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(c.courseId);
  const newQuiz = [{ prompt: 'Only question?', options: ['a', 'b', 'c', 'd'], correct_index: 0 }];
  await h.pool.query(`INSERT INTO section_quizzes (section_id, version_id, questions, verified_at) VALUES ($1, $2, $3::jsonb, $4)`, [c.sectionIds[0], v2.id, JSON.stringify(newQuiz), h.clock.now]);

  const before = await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT });
  assert.equal(before.json().total, 3, 'the building version is not used');
  await versions.publish(v2.id);
  assert.equal((await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT })).statusCode, 400, 'three answers no longer fit a one-question quiz');
  const after = await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: [0] });
  assert.deepEqual([after.json().total, after.json().score], [1, 1]);
});

ct('quiz results are each reader\'s own, and a section of another course or a hidden course is 404', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  const other = await publishedCourse(h.pool);
  await post(alice.token, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT });
  assert.equal(await result(bob.id, c.sectionIds[0]!), undefined);
  assert.equal((await post(bob.token, url(c.courseId, other.sectionIds[0]!), { answers: RIGHT })).statusCode, 404);
  assert.equal((await post(bob.token, url(c.courseId, 'nope'), { answers: RIGHT })).statusCode, 404);
  assert.equal((await post(bob.token, url('00000000-0000-4000-8000-000000000000', c.sectionIds[0]!), { answers: RIGHT })).statusCode, 404);
  assert.equal((await post(undefined, url(c.courseId, c.sectionIds[0]!), { answers: RIGHT })).statusCode, 401);
});

ct('a withdrawn course answers 409 and a switched-off feature 503', async () => {
  const { alice } = await people();
  const w = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, w, { accountId: alice.id });
  const res = await post(alice.token, url(w.courseId, w.sectionIds[0]!), { answers: RIGHT });
  assert.deepEqual([res.statusCode, res.json()], [409, { error: 'course_withdrawn' }]);
  await settings().set('courses_off', true);
  assert.equal((await post(alice.token, url(w.courseId, w.sectionIds[0]!), { answers: RIGHT })).statusCode, 503);
});
