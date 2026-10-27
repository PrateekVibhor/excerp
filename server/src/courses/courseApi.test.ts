// Plan 16, phase 2, step 5: the read endpoints and who may see what (spec 16, section 5). Real API over real SQL, signed in through
// the same test sign-in the other features use. An account that may not see a course is told 404, never 403.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { enrolReader, pendingCourse, privateCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';
import { createVersionStore } from './versions.ts';

const h = useHarness('coursesapi');
const NOT_FOUND = { error: 'not found' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** A course test: the harness's clean database, with courses switched on. */
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });

const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
/** Signs the users in so their accounts exist, and returns their tokens and account ids. */
async function people() {
  const [a, b] = [await h.signIn('alice'), await h.signIn('bob')];
  return { alice: { token: a.token, id: await idOf('alice') }, bob: { token: b.token, id: await idOf('bob') } };
}

ct('Scenario: every course endpoint needs a signed-in, approved account', async () => {
  const c = await publishedCourse(h.pool);
  for (const url of [`/courses/${c.courseId}`, `/courses/${c.courseId}/transparency`, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`, `/courses/${c.courseId}/concepts`, `/concepts/${c.conceptIds[0]}/resources`, `/courses/${c.courseId}/sections/${c.sectionIds[0]}/quiz`, '/me/courses']) {
    const res = await get(undefined, url);
    assert.equal(res.statusCode, 401, url);
    assert.equal(res.headers['cache-control'], 'no-store', url);
  }
  const stranger = await h.signIn('stranger'); // not on the allow-list: pending, no session
  assert.equal(stranger.res.json().status, 'pending');
});

ct('Scenario: with courses switched off every course endpoint answers 503 courses_off', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await createCourseSettings(h.pool).set('courses_off', true);
  for (const url of [`/courses/${c.courseId}`, `/courses/${c.courseId}/concepts`, '/me/courses']) {
    const res = await get(alice.token, url);
    assert.deepEqual([res.statusCode, res.json()], [503, { error: 'courses_off' }], url);
  }
});

ct('Scenario: the course home carries the sections with their chapters, quiz state, progress and has_updates in one call', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool, { roleName: 'product manager' });
  await enrolReader(h.pool, c, { accountId: alice.id, readChapters: 2, quizBest: 2 });

  const res = await get(alice.token, `/courses/${c.courseId}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const home = res.json();
  assert.deepEqual(Object.keys(home).sort(), ['evidence_thin', 'has_updates', 'id', 'industry', 'mode', 'pool_size', 'progress', 'role', 'sections', 'status', 'title'].sort());
  assert.deepEqual([home.id, home.status, home.role, home.pool_size, home.evidence_thin, home.has_updates], [c.courseId, 'ready', 'product manager', 9, false, false]);
  assert.deepEqual(home.progress, { read: 2, total: 6 });
  assert.equal(home.sections.length, 2);
  assert.deepEqual(home.sections[0].chapters.map((x: { id: string }) => x.id), c.chapterIds.slice(0, 3));
  assert.deepEqual(home.sections[0].chapters.map((x: { read: boolean }) => x.read), [true, true, false]);
  assert.deepEqual(home.sections[0].chapters[0], { id: c.chapterIds[0], title: 'Chapter 1', read: true });
  assert.deepEqual(home.sections[0].quiz, { taken: true, best_score: 2 });
  assert.deepEqual(home.sections[1].quiz, { taken: false, best_score: null });
  assert.deepEqual(home.sections[1].chapters.map((x: { read: boolean }) => x.read), [false, false, false]);

  // Anyone signed in can open a ready shared course; their own marks are theirs alone.
  const other = (await get(bob.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(other.progress, { read: 0, total: 6 });
  assert.ok(other.sections.every((s: { chapters: Array<{ read: boolean }> }) => s.chapters.every((x) => !x.read)));
});

ct('has_updates is true once a version with published changes is past what the reader has seen', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await enrolReader(h.pool, c, { accountId: alice.id });
  await enrolReader(h.pool, c, { accountId: bob.id });
  await h.pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1)`, [alice.id, c.courseId]);
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(c.courseId);
  await h.pool.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_added', 'A new chapter')`, [c.courseId, v2.id]);
  const flag = async (user: { token: string }) => (await get(user.token, `/courses/${c.courseId}`)).json().has_updates;
  assert.equal(await flag(alice), false, 'a change in a version that is not published is hidden');
  await versions.publish(v2.id);
  assert.equal(await flag(alice), true);
  assert.equal(await flag(bob), false, 'no seen row: nothing to compare');
  await h.pool.query(`UPDATE course_seen SET seen_version = 2 WHERE account_id = $1`, [alice.id]);
  assert.equal(await flag(alice), false);
});

ct('Scenario: a course an account may not see answers 404 on every endpoint, never 403', async () => {
  const { alice, bob } = await people();
  const live = await publishedCourse(h.pool);
  const mine = await privateCourse(h.pool, { ownerId: bob.id });
  const pendingOfBob = await pendingCourse(h.pool, { requesterId: bob.id });
  const building = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [building.courseId]);
  await enrolReader(h.pool, building, { accountId: bob.id });
  const withdrawn = await withdrawnCourse(h.pool);
  await enrolReader(h.pool, withdrawn, { accountId: bob.id });

  const hidden = [
    { courseId: UNKNOWN, chapterId: live.chapterIds[0], sectionId: live.sectionIds[0] },
    { courseId: 'not-a-uuid', chapterId: live.chapterIds[0], sectionId: live.sectionIds[0] },
    { courseId: mine.courseId, chapterId: mine.chapterId, sectionId: mine.sectionId }, // bob's private course
    { courseId: pendingOfBob.courseId, chapterId: UNKNOWN, sectionId: UNKNOWN }, // bob's pending attempt
    { courseId: building.courseId, chapterId: building.chapterIds[0], sectionId: building.sectionIds[0] }, // being built, alice has not joined
    { courseId: withdrawn.courseId, chapterId: withdrawn.chapterIds[0], sectionId: withdrawn.sectionIds[0] }, // withdrawn, alice never joined
  ];
  for (const { courseId, chapterId, sectionId } of hidden) {
    for (const url of [`/courses/${courseId}`, `/courses/${courseId}/transparency`, `/courses/${courseId}/concepts`, `/courses/${courseId}/chapters/${chapterId}`, `/courses/${courseId}/sections/${sectionId}/quiz`]) {
      const res = await get(alice.token, url);
      assert.deepEqual([res.statusCode, res.json()], [404, NOT_FOUND], url);
    }
  }
  // A course alice may see, asked about a chapter or a section that belongs to another course.
  for (const url of [`/courses/${live.courseId}/chapters/${mine.chapterId}`, `/courses/${live.courseId}/chapters/nope`, `/courses/${live.courseId}/sections/${mine.sectionId}/quiz`, `/courses/${live.courseId}/sections/nope/quiz`]) {
    const res = await get(alice.token, url);
    assert.deepEqual([res.statusCode, res.json()], [404, NOT_FOUND], url);
  }
  assert.equal((await get(alice.token, `/concepts/${mine.privateConceptId}/resources`)).statusCode, 404, "bob's private concept");
  assert.equal((await get(alice.token, `/concepts/${UNKNOWN}/resources`)).statusCode, 404);
  assert.equal((await get(alice.token, `/concepts/nope/resources`)).statusCode, 404);
  // The owner sees it.
  assert.equal((await get(bob.token, `/courses/${mine.courseId}`)).statusCode, 200);
  assert.equal((await get(bob.token, `/concepts/${mine.privateConceptId}/resources`)).statusCode, 200);
  // And the live course is there for alice, so the 404s above were about access and not a broken route.
  assert.equal((await get(alice.token, `/courses/${live.courseId}`)).statusCode, 200);
});

ct('the person who started a pending attempt sees where it is; a failed or cancelled attempt says so', async () => {
  const { alice } = await people();
  const pending = await pendingCourse(h.pool, { requesterId: alice.id });
  const home = (await get(alice.token, `/courses/${pending.courseId}`)).json();
  assert.deepEqual(Object.keys(home).sort(), ['id', 'industry', 'mode', 'role', 'status', 'title']);
  assert.equal(home.status, 'awaiting_approval');
  await h.pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'not_enough_postings' WHERE id = $1`, [pending.courseId]);
  const failed = (await get(alice.token, `/courses/${pending.courseId}`)).json();
  assert.deepEqual([failed.status, failed.failure_reason], ['failed', 'not_enough_postings']);
  await h.pool.query(`UPDATE courses SET status = 'cancelled', failure_reason = NULL WHERE id = $1`, [pending.courseId]);
  assert.equal((await get(alice.token, `/courses/${pending.courseId}`)).json().status, 'cancelled');
  // No content endpoint answers for an attempt that has no course yet.
  assert.equal((await get(alice.token, `/courses/${pending.courseId}/concepts`)).statusCode, 404);
});

ct('a course being built shows its stage and percent to the people who joined it', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [c.courseId]);
  await h.pool.query(`UPDATE course_runs SET stage = 'write chapters', percent = 55, finished_at = NULL WHERE course_id = $1`, [c.courseId]);
  await enrolReader(h.pool, c, { accountId: alice.id });
  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(home, { id: c.courseId, status: 'building', title: c.roleName, role: c.roleName, industry: null, mode: 'narrow', stage: 'write chapters', percent: 55 });
});

ct('Scenario: a withdrawn course shows a notice and no content, and the content endpoints answer 409 course_withdrawn', async () => {
  const { alice } = await people();
  const c = await withdrawnCourse(h.pool, { note: 'This course is being corrected.' });
  await enrolReader(h.pool, c, { accountId: alice.id, readChapters: 1 });
  const home = (await get(alice.token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(home, {
    id: c.courseId, status: 'withdrawn', title: c.roleName, role: c.roleName, industry: null, mode: 'narrow',
    withdrawal: { note: 'This course is being corrected.', withdrawn_at: '2026-10-12T12:00:00.000Z' }, progress: { read: 1, total: 6 },
  });
  for (const url of [`/courses/${c.courseId}/chapters/${c.chapterIds[0]}`, `/courses/${c.courseId}/concepts`, `/courses/${c.courseId}/sections/${c.sectionIds[0]}/quiz`, `/courses/${c.courseId}/transparency`]) {
    const res = await get(alice.token, url);
    assert.deepEqual([res.statusCode, res.json()], [409, { error: 'course_withdrawn' }], url);
  }
  const mine = (await get(alice.token, '/me/courses')).json();
  assert.deepEqual(mine.courses.map((x: { id: string; status: string; withdrawal?: { note: string } }) => [x.id, x.status, x.withdrawal?.note]), [[c.courseId, 'withdrawn', 'This course is being corrected.']]);
});

ct('Scenario: a chapter comes with its concepts, badges and review state, as the published version has it', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const versions = createVersionStore(h.pool, () => h.clock.now);
  const v2 = await versions.start(c.courseId);
  await h.pool.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Rewritten', 'Not live yet.')`, [c.chapterIds[0], v2.id]);

  const res = await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const ch = res.json();
  assert.deepEqual([ch.id, ch.title, ch.section_id, ch.position, ch.under_review], [c.chapterIds[0], 'Chapter 1', c.sectionIds[0], 0, false]);
  assert.match(ch.body, /chapter 1/);
  assert.equal(ch.concepts.length, 2);
  assert.deepEqual(ch.concepts[0], { id: c.conceptIds[0], name: `${c.roleName} skill 1`, explanation: 'A plain explanation of skill 1.', criticality: 'high', mentions: 8, of_postings: 9, from_your_posting: false, in_your_posting: false, tools: [] });
  assert.equal(ch.concepts[1].criticality, 'high', 'six of nine postings');

  await h.pool.query(`UPDATE course_chapters SET status = 'under_review' WHERE id = $1`, [c.chapterIds[0]]);
  assert.equal((await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`)).json().under_review, true);
  await h.pool.query(`UPDATE course_chapters SET status = 'removed' WHERE id = $1`, [c.chapterIds[0]]);
  assert.equal((await get(alice.token, `/courses/${c.courseId}/chapters/${c.chapterIds[0]}`)).statusCode, 404);
});

ct('a concept only the reader\'s own posting asks for is marked, and carries no badge', async () => {
  const { bob } = await people();
  const c = await privateCourse(h.pool, { ownerId: bob.id });
  const ch = (await get(bob.token, `/courses/${c.courseId}/chapters/${c.chapterId}`)).json();
  const own = ch.concepts.find((k: { id: string }) => k.id === c.privateConceptId);
  assert.deepEqual([own.from_your_posting, own.criticality, own.mentions], [true, null, 0]);
  const shared = ch.concepts.find((k: { id: string }) => k.id === c.sharedConceptId);
  assert.deepEqual([shared.from_your_posting, shared.criticality], [false, 'high']);
});

ct('the concepts panel lists every concept of the course in order with badges and mention counts', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await get(alice.token, `/courses/${c.courseId}/concepts`);
  assert.equal(res.statusCode, 200);
  const { concepts } = res.json();
  assert.deepEqual(concepts.map((k: { id: string }) => k.id), c.conceptIds);
  assert.deepEqual(concepts.slice(0, 6).map((k: { criticality: string }) => k.criticality), ['high', 'high', 'medium', 'medium', 'medium', 'low']);
  assert.deepEqual([concepts[0].mentions, concepts[0].of_postings], [8, 9]);
});

ct('go deeper: a concept\'s resources, at least two, with kind, title, source, link and why', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await get(alice.token, `/concepts/${c.conceptIds[0]}/resources`);
  assert.equal(res.statusCode, 200);
  const { resources } = res.json();
  assert.ok(resources.length >= 2);
  assert.deepEqual(Object.keys(resources[0]).sort(), ['kind', 'source', 'title', 'url', 'why']);
  assert.ok(['article', 'blog', 'video'].includes(resources[0].kind));
});

ct('Scenario: a section quiz is sent without its answers', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await get(alice.token, `/courses/${c.courseId}/sections/${c.sectionIds[0]}/quiz`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const quiz = res.json();
  assert.equal(quiz.section_id, c.sectionIds[0]);
  assert.equal(quiz.questions.length, 3);
  for (const q of quiz.questions) {
    assert.deepEqual(Object.keys(q).sort(), ['options', 'prompt']);
    assert.equal(q.options.length, 4);
  }
  assert.doesNotMatch(res.body, /correct_index|"answer"/);
});

ct('Scenario: transparency says how many US postings the course was built from, and lists them with links', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  const res = await get(alice.token, `/courses/${c.courseId}/transparency`);
  assert.equal(res.statusCode, 200);
  const t = res.json();
  assert.equal(t.line, 'Built from 9 US job postings');
  assert.equal(t.count, 9);
  assert.equal(t.sources.length, 9);
  assert.deepEqual(Object.keys(t.sources[0]).sort(), ['company', 'designation', 'match', 'role_title', 'url']);
  assert.match(t.sources[0].url, /^https:\/\//);
  assert.equal(t.date, '2026-10-12T12:00:00.000Z');
  assert.match(t.how, /60%.*25%/);
  // A posting that has closed is no longer counted.
  await h.pool.query(`UPDATE sources SET status = 'closed' WHERE id = $1`, [c.sourceIds[0]]);
  const after = (await get(alice.token, `/courses/${c.courseId}/transparency`)).json();
  assert.deepEqual([after.count, after.line], [8, 'Built from 8 US job postings']);
});

ct('a private course\'s pasted description is never listed as a posting', async () => {
  const { bob } = await people();
  const c = await privateCourse(h.pool, { ownerId: bob.id });
  const t = (await get(bob.token, `/courses/${c.courseId}/transparency`)).json();
  assert.equal(t.count, 0);
  assert.equal(t.sources.length, 0);
  assert.equal(JSON.stringify(t).includes('Not named'), false);
});

ct('Scenario: my courses lists only the courses the account has joined, with progress, status and updates', async () => {
  const { alice, bob } = await people();
  const first = await publishedCourse(h.pool);
  const second = await publishedCourse(h.pool);
  const notMine = await publishedCourse(h.pool);
  await enrolReader(h.pool, first, { accountId: alice.id, readChapters: 3, lastActiveAt: '2026-10-01T00:00:00.000Z' });
  await enrolReader(h.pool, second, { accountId: alice.id, readChapters: 1, lastActiveAt: '2026-10-05T00:00:00.000Z' });
  await enrolReader(h.pool, notMine, { accountId: bob.id });
  const res = await get(alice.token, '/me/courses');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const { courses } = res.json();
  assert.deepEqual(courses.map((x: { id: string }) => x.id), [second.courseId, first.courseId], 'most recently active first');
  const { created_at, ...rest } = courses[1];
  assert.ok(typeof created_at === 'string', 'when the reader joined');
  assert.deepEqual(rest, {
    id: first.courseId, title: first.roleName, role: first.roleName, status: 'ready', mode: 'narrow', progress: { read: 3, total: 6 }, has_updates: false,
    visibility: 'shared', independent: false, industry: null, industry_label: null, custom_title: null, last_active_at: '2026-10-01T00:00:00.000Z', checked_at: null, refreshing: false, coverage: null,
  }); // a narrative course carries the same fields, with no coverage
  assert.deepEqual((await get(bob.token, '/me/courses')).json().courses.map((x: { id: string }) => x.id), [notMine.courseId]);
  assert.deepEqual((await get((await h.signIn('carol')).token, '/me/courses')).json(), { courses: [] });
});
