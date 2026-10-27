// Plan 16, phase 2, step 3: a chapter keeps its identity across versions, so a reader's progress survives every update, and a
// refresh never deletes one. Text and quizzes read as the latest row at or before the published version.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { enrolReader, publishedCourse } from '../../testkit/courseFixtures.ts';
import { createCourseStore } from './store.ts';
import { createVersionStore } from './versions.ts';

const { db } = useCourseDb('identity');
const clock = { now: new Date('2026-10-20T09:00:00.000Z') };
const versions = (p: import('pg').Pool) => createVersionStore(p, () => clock.now);
const count = async (p: import('pg').Pool, sql: string, args: unknown[] = []) => Number((await p.query(sql, args)).rows[0].count);

const rewrite = (p: import('pg').Pool, chapterId: string, versionId: string, body: string) =>
  p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Rewritten', $3)`, [chapterId, versionId, body]);

db('Scenario: reader progress survives a rewrite: the chapter keeps its identity and the reader keeps their marks', async (p) => {
  const c = await publishedCourse(p);
  const reader = await enrolReader(p, c, { readChapters: 3, quizBest: 2 });
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'Chapter one, rewritten.');
  await versions(p).publish(v2.id);

  const ch = await store.publishedChapter(c.courseId, c.chapterIds[0]!);
  assert.equal(ch?.id, c.chapterIds[0], 'the same chapter id');
  assert.equal(ch?.body, 'Chapter one, rewritten.');
  assert.equal(await count(p, `SELECT count(*) FROM course_progress WHERE account_id = $1`, [reader.accountId]), 3);
  assert.equal((await p.query(`SELECT best_score FROM section_quiz_results WHERE account_id = $1`, [reader.accountId])).rows[0].best_score, 2);
  assert.equal(await count(p, `SELECT count(*) FROM course_chapters WHERE id = ANY($1)`, [c.chapterIds]), 6, 'no chapter was replaced or deleted');
});

db('a chapter that did not change has no row for the new version and still reads as its earlier text', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'Only chapter one changed.');
  await versions(p).publish(v2.id);
  assert.equal(await count(p, `SELECT count(*) FROM chapter_texts WHERE version_id = $1`, [v2.id]), 1);
  const untouched = await store.publishedChapter(c.courseId, c.chapterIds[1]!);
  assert.equal(untouched?.version, 1);
  assert.match(untouched!.body, /chapter 2/);
});

db('a chapter added in a new version is not visible until that version is published', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  const added = (await p.query(`INSERT INTO course_chapters (section_id, position, added_in_version) VALUES ($1, 3, $2) RETURNING id`, [c.sectionIds[0], v2.id])).rows[0].id as string;
  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'New', 'A brand new chapter.')`, [added, v2.id]);

  assert.equal(await store.publishedChapter(c.courseId, added), null);
  assert.equal((await store.publishedOutline(c.courseId))[0]!.chapters.length, 3);

  await versions(p).publish(v2.id);
  assert.equal((await store.publishedChapter(c.courseId, added))?.body, 'A brand new chapter.');
  const outline = await store.publishedOutline(c.courseId);
  assert.equal(outline[0]!.chapters.length, 4);
  assert.deepEqual(outline[0]!.chapters.map((x) => x.position), [0, 1, 2, 3]);
});

db('the outline lists sections and chapters in order with the latest titles', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  await rewrite(p, c.chapterIds[1]!, v2.id, 'Second chapter, new body.');
  await versions(p).publish(v2.id);
  const outline = await store.publishedOutline(c.courseId);
  assert.equal(outline.length, 2);
  assert.deepEqual(outline.map((s) => s.position), [0, 1]);
  assert.deepEqual(outline[0]!.chapters.map((x) => x.title), ['Chapter 1', 'Rewritten', 'Chapter 3']);
  assert.deepEqual(outline[0]!.chapters.map((x) => x.id), c.chapterIds.slice(0, 3));
});

db('Scenario: removing a chapter hides it but keeps the row and the reader marks; nothing else removes one', async (p) => {
  const c = await publishedCourse(p);
  const reader = await enrolReader(p, c, { readChapters: 2 });
  const store = createCourseStore(p);
  await store.removeChapter(c.chapterIds[0]!);
  assert.equal(await store.publishedChapter(c.courseId, c.chapterIds[0]!), null);
  assert.equal((await store.publishedOutline(c.courseId))[0]!.chapters.length, 2);
  assert.equal((await p.query(`SELECT status FROM course_chapters WHERE id = $1`, [c.chapterIds[0]])).rows[0].status, 'removed');
  assert.equal(await count(p, `SELECT count(*) FROM course_progress WHERE account_id = $1`, [reader.accountId]), 2, 'the read marks stay');
  assert.equal(await count(p, `SELECT count(*) FROM chapter_texts WHERE chapter_id = $1`, [c.chapterIds[0]]), 1, 'the text stays');
});

db('Scenario: a refresh, whether it publishes or fails, never deletes a chapter', async (p) => {
  const c = await publishedCourse(p);
  const v = versions(p);
  const before = await count(p, `SELECT count(*) FROM course_chapters WHERE section_id = ANY($1)`, [c.sectionIds]);

  const v2 = await v.start(c.courseId);
  await rewrite(p, c.chapterIds[2]!, v2.id, 'Edited.');
  await v.fail(v2.id, 'qa_failed');
  const v3 = await v.start(c.courseId);
  await rewrite(p, c.chapterIds[3]!, v3.id, 'Edited and published.');
  await v.publish(v3.id);

  assert.equal(await count(p, `SELECT count(*) FROM course_chapters WHERE section_id = ANY($1)`, [c.sectionIds]), before);
  assert.equal(await count(p, `SELECT count(*) FROM course_chapters WHERE section_id = ANY($1) AND status = 'removed'`, [c.sectionIds]), 0);
});

db('a failed or still-building version never shows its text, whatever its number', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v = versions(p);
  const v2 = await v.start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'Failed text.');
  await v.fail(v2.id, 'qa_failed');
  const v3 = await v.start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v3.id, 'Building text.');
  assert.match((await store.publishedChapter(c.courseId, c.chapterIds[0]!))!.body, /chapter 1/);
  await v.publish(v3.id);
  assert.equal((await store.publishedChapter(c.courseId, c.chapterIds[0]!))!.body, 'Building text.', 'published, so now it shows (a failed v2 is skipped)');
  assert.equal((await store.publishedChapter(c.courseId, c.chapterIds[0]!))!.version, 3);
});

db('a section quiz is regenerated only for a section that changed; the other reads as its earlier quiz', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  const newQuiz = [{ prompt: 'New question?', options: ['a', 'b', 'c', 'd'], correct_index: 0 }];
  await p.query(`INSERT INTO section_quizzes (section_id, version_id, questions, verified_at) VALUES ($1, $2, $3::jsonb, $4)`, [c.sectionIds[0], v2.id, JSON.stringify(newQuiz), clock.now]);

  assert.equal((await store.publishedQuiz(c.sectionIds[0]!))?.version, 1, 'before publishing');
  await versions(p).publish(v2.id);
  const first = await store.publishedQuiz(c.sectionIds[0]!);
  const second = await store.publishedQuiz(c.sectionIds[1]!);
  assert.equal(first?.version, 2);
  assert.equal((first!.questions as unknown[]).length, 1);
  assert.equal(second?.version, 1);
  assert.equal((second!.questions as unknown[]).length, 3);
});

db('text written only in a version that failed is skipped: the chapter reads as its last good text', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v = versions(p);
  const v2 = await v.start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'Only the failed version has this.');
  await v.fail(v2.id, 'qa_failed');
  const v3 = await v.start(c.courseId);
  await v.publish(v3.id); // version 3 changed nothing
  const ch = await store.publishedChapter(c.courseId, c.chapterIds[0]!);
  assert.equal(ch?.version, 1);
  assert.match(ch!.body, /chapter 1/);
});
