// Plan 16, phase 2, step 3: a course is built in versions. A new version is made beside the live one and replaces it in one
// transaction; a failed version changes nothing for readers. Real SQL, throwaway schema.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createCourseStore } from './store.ts';
import { createVersionStore, VersionError } from './versions.ts';

const { db } = useCourseDb('versions');
const clock = { now: new Date('2026-10-20T09:00:00.000Z') };
const versions = (p: import('pg').Pool) => createVersionStore(p, () => clock.now);

const course = async (p: import('pg').Pool, id: string) => (await p.query(`SELECT status, published_version, failure_reason, withdrawn_at, withdrawal_note, pool_size, evidence_thin, next_check_at, last_checked_at, generated_at FROM courses WHERE id = $1`, [id])).rows[0];
const versionRow = async (p: import('pg').Pool, id: string) => (await p.query(`SELECT version, status, published_at FROM course_versions WHERE id = $1`, [id])).rows[0];
const rejectsWith = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => e instanceof VersionError && e.code === code, `expected VersionError ${code}`);

/** Gives a chapter new text in a version, as a refresh does. */
const rewrite = (p: import('pg').Pool, chapterId: string, versionId: string, body: string) =>
  p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Rewritten', $3)`, [chapterId, versionId, body]);

db('Scenario: a new version is built beside the live one, which readers keep seeing until it is published', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId, { model: 'fixture-model' });
  assert.equal(v2.version, 2);
  assert.equal((await versionRow(p, v2.id)).status, 'building');
  await rewrite(p, c.chapterIds[0]!, v2.id, 'New text, not yet live.');

  assert.equal((await course(p, c.courseId)).published_version, c.versionId, 'the live version has not moved');
  const seen = await store.publishedChapter(c.courseId, c.chapterIds[0]!);
  assert.equal(seen?.version, 1);
  assert.match(seen!.body, /chapter 1/);
});

db('only one version is built at a time; the next number follows the highest, failed ones included', async (p) => {
  const c = await publishedCourse(p);
  const v = versions(p);
  const v2 = await v.start(c.courseId);
  await rejectsWith(v.start(c.courseId), 'busy');
  await v.fail(v2.id, 'qa_failed');
  const v3 = await v.start(c.courseId);
  assert.equal(v3.version, 3);
  await rejectsWith(v.start('00000000-0000-4000-8000-000000000000'), 'not_found');
});

db('Scenario: publishing swaps the live version in one transaction', async (p) => {
  const c = await publishedCourse(p);
  const store = createCourseStore(p);
  const v2 = await versions(p).start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'The second version of chapter one.');
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_corrected', 'Chapter 1 was corrected.')`, [c.courseId, v2.id]);
  assert.equal((await p.query(`SELECT published_at FROM course_changes WHERE version_id = $1`, [v2.id])).rows[0].published_at, null, 'a change is hidden until its version is live');

  await versions(p).publish(v2.id);

  const after = await course(p, c.courseId);
  assert.equal(after.published_version, v2.id);
  assert.equal(after.status, 'ready');
  assert.equal((await versionRow(p, c.versionId)).status, 'superseded');
  const now = await versionRow(p, v2.id);
  assert.equal(now.status, 'published');
  assert.equal(now.published_at.toISOString(), clock.now.toISOString());
  assert.equal((await p.query(`SELECT count(*) FROM course_versions WHERE course_id = $1 AND status = 'published'`, [c.courseId])).rows[0].count, '1');
  assert.equal((await p.query(`SELECT published_at FROM course_changes WHERE version_id = $1`, [v2.id])).rows[0].published_at.toISOString(), clock.now.toISOString());
  assert.equal((await store.publishedChapter(c.courseId, c.chapterIds[0]!))?.body, 'The second version of chapter one.');
});

db('publishing records what the build learned about the course', async (p) => {
  const c = await publishedCourse(p);
  const v2 = await versions(p).start(c.courseId);
  const next = new Date('2026-12-04T09:00:00.000Z');
  await versions(p).publish(v2.id, { course: { poolSize: 7, evidenceThin: true, nextCheckAt: next, lastCheckedAt: clock.now } });
  const after = await course(p, c.courseId);
  assert.equal(after.pool_size, 7);
  assert.equal(after.evidence_thin, true);
  assert.equal(after.next_check_at.toISOString(), next.toISOString());
  assert.equal(after.last_checked_at.toISOString(), clock.now.toISOString());
});

db('the first build of a course goes from building to ready, and a version that is not being built cannot be published', async (p) => {
  const c = await publishedCourse(p);
  await p.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [c.courseId]);
  await p.query(`UPDATE course_versions SET status = 'building', published_at = NULL WHERE id = $1`, [c.versionId]);
  await versions(p).publish(c.versionId);
  const after = await course(p, c.courseId);
  assert.equal(after.status, 'ready');
  assert.equal(after.published_version, c.versionId);
  assert.equal(after.generated_at.toISOString(), clock.now.toISOString());

  await rejectsWith(versions(p).publish(c.versionId), 'not_building'); // already published
  const v2 = await versions(p).start(c.courseId);
  await versions(p).fail(v2.id, 'qa_failed');
  await rejectsWith(versions(p).publish(v2.id), 'not_building'); // failed
  await rejectsWith(versions(p).publish('00000000-0000-4000-8000-000000000000'), 'not_found');
});

db('Scenario: if publishing fails part-way nothing changes: the old version stays live and the new one is still building', async (p) => {
  const c = await publishedCourse(p);
  const v2 = await versions(p).start(c.courseId);
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_added', 'A new chapter')`, [c.courseId, v2.id]);
  // A trigger that refuses the last step of the swap, so the earlier steps have already run when it fails.
  await p.query(`CREATE FUNCTION refuse_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
  await p.query(`CREATE TRIGGER refuse_publish_trg BEFORE UPDATE OF published_version ON courses FOR EACH ROW WHEN (NEW.published_version IS DISTINCT FROM OLD.published_version) EXECUTE FUNCTION refuse_publish()`);
  try {
    await assert.rejects(versions(p).publish(v2.id), /refused for the test/);
  } finally {
    await p.query(`DROP TRIGGER refuse_publish_trg ON courses`);
  }
  assert.equal((await course(p, c.courseId)).published_version, c.versionId);
  assert.equal((await versionRow(p, c.versionId)).status, 'published');
  assert.equal((await versionRow(p, v2.id)).status, 'building');
  assert.equal((await p.query(`SELECT published_at FROM course_changes WHERE version_id = $1`, [v2.id])).rows[0].published_at, null);
  await versions(p).publish(v2.id); // and it can be published once the problem is gone
  assert.equal((await course(p, c.courseId)).published_version, v2.id);
});

db('two publishes of the same version at once: exactly one wins and the state stays consistent', async (p) => {
  const c = await publishedCourse(p);
  const v2 = await versions(p).start(c.courseId);
  const results = await Promise.allSettled([versions(p).publish(v2.id), versions(p).publish(v2.id), versions(p).publish(v2.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof VersionError && r.reason.code === 'not_building');
  assert.equal((await course(p, c.courseId)).published_version, v2.id);
  assert.equal((await p.query(`SELECT count(*) FROM course_versions WHERE course_id = $1 AND status = 'published'`, [c.courseId])).rows[0].count, '1');
});

db('Scenario: a failing check publishes nothing: a refresh leaves the course ready on its old version', async (p) => {
  const c = await publishedCourse(p);
  const v2 = await versions(p).start(c.courseId);
  await rewrite(p, c.chapterIds[0]!, v2.id, 'Text that failed the checks.');
  await versions(p).fail(v2.id, 'qa_failed');
  const after = await course(p, c.courseId);
  assert.equal(after.status, 'ready');
  assert.equal(after.published_version, c.versionId);
  assert.equal((await versionRow(p, v2.id)).status, 'failed');
  assert.match((await createCourseStore(p).publishedChapter(c.courseId, c.chapterIds[0]!))!.body, /chapter 1/, 'readers still see the old text');
});

db('a first build that fails ends the course failed with its reason', async (p) => {
  const c = await publishedCourse(p);
  await p.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [c.courseId]);
  await p.query(`UPDATE course_versions SET status = 'building', published_at = NULL WHERE id = $1`, [c.versionId]);
  await versions(p).fail(c.versionId, 'qa_failed');
  const after = await course(p, c.courseId);
  assert.equal(after.status, 'failed');
  assert.equal(after.failure_reason, 'qa_failed');
  assert.equal(after.published_version, null);
  assert.equal((await versionRow(p, c.versionId)).status, 'failed');
  await rejectsWith(versions(p).fail(c.versionId, 'again'), 'not_building');
});

db('Scenario: a withdrawn course is not refreshed; a correction that passes republishes it and clears the notice', async (p) => {
  const c = await withdrawnCourse(p, { note: 'Being corrected.' });
  const v2 = await versions(p).start(c.courseId);
  await rejectsWith(versions(p).publish(v2.id), 'withdrawn'); // a refresh cannot publish while withdrawn
  assert.equal((await course(p, c.courseId)).status, 'withdrawn');

  await versions(p).publish(v2.id, { correction: true });
  const after = await course(p, c.courseId);
  assert.equal(after.status, 'ready');
  assert.equal(after.withdrawn_at, null);
  assert.equal(after.withdrawal_note, null);
  assert.equal(after.published_version, v2.id);
});

db('a correction that fails leaves the course withdrawn', async (p) => {
  const c = await withdrawnCourse(p);
  const v2 = await versions(p).start(c.courseId);
  await versions(p).fail(v2.id, 'qa_failed');
  const after = await course(p, c.courseId);
  assert.equal(after.status, 'withdrawn');
  assert.ok(after.withdrawn_at);
  assert.equal(after.published_version, c.versionId);
});
