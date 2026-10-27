// The course fixtures themselves: the hand-made sample courses that every later phase 2 test builds on must be complete,
// consistent with the schema's rules, and never collide with each other.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { NOW, account, enrolReader, role, source, flagChapter, pendingCourse, privateCourse, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';

const { db } = useCourseDb('fixtures');
const count = async (p: import('pg').Pool, sql: string, args: unknown[] = []) => Number((await p.query(sql, args)).rows[0].count);

db('a published course is complete: versions, sections, chapters, texts, concepts, resources, quizzes, bible and a finished run', async (p) => {
  const c = await publishedCourse(p);
  const course = (await p.query(`SELECT status, visibility, published_version, pool_size, evidence_thin FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.equal(course.status, 'ready');
  assert.equal(course.visibility, 'shared');
  assert.equal(course.published_version, c.versionId);
  assert.equal(course.pool_size, 9);
  assert.equal(course.evidence_thin, false);
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [c.versionId])).rows[0].status, 'published');

  assert.equal(c.sectionIds.length, 2);
  assert.equal(c.chapterIds.length, 6);
  for (const ch of c.chapterIds) {
    assert.equal(await count(p, `SELECT count(*) FROM chapter_texts WHERE chapter_id = $1 AND version_id = $2`, [ch, c.versionId]), 1);
    const n = await count(p, `SELECT count(*) FROM chapter_concepts WHERE chapter_id = $1`, [ch]);
    assert.ok(n === 2 || n === 3, 'two or three concepts per chapter');
  }
  for (const s of c.sectionIds) {
    const quiz = (await p.query(`SELECT questions FROM section_quizzes WHERE section_id = $1 AND version_id = $2`, [s, c.versionId])).rows[0].questions;
    assert.equal(quiz.length, 3);
    for (const q of quiz) assert.equal(q.options.length, 4);
  }
  for (const k of c.conceptIds) assert.ok((await count(p, `SELECT count(*) FROM resources WHERE concept_id = $1`, [k])) >= 2, 'two or more resources per concept');
  assert.equal(await count(p, `SELECT count(*) FROM story_bible WHERE course_id = $1 AND version_id = $2`, [c.courseId, c.versionId]), 1);
  const run = (await p.query(`SELECT kind, tavily_credits, tokens_in, finished_at FROM course_runs WHERE course_id = $1`, [c.courseId])).rows[0];
  assert.equal(run.kind, 'generation');
  assert.ok(run.tavily_credits > 0 && Number(run.tokens_in) > 0 && run.finished_at);
});

db('the evidence is consistent: nine distinct employers, mentions counted from source_skills, criticality from the share', async (p) => {
  const c = await publishedCourse(p);
  assert.equal(c.sourceIds.length, 9);
  assert.equal(await count(p, `SELECT count(DISTINCT company) FROM sources WHERE id = ANY($1)`, [c.sourceIds]), 9);
  assert.equal(await count(p, `SELECT count(*) FROM course_sources WHERE course_id = $1 AND use = 'pool' AND state = 'approved'`, [c.courseId]), 9);
  const rows = (await p.query(`SELECT k.mentions, k.of_postings, k.criticality, (SELECT count(*) FROM source_skills ss WHERE ss.concept_id = k.id) AS counted FROM role_concepts k WHERE k.id = ANY($1)`, [c.conceptIds])).rows;
  const bands = new Set<string>();
  for (const r of rows) {
    assert.equal(r.of_postings, 9);
    assert.equal(r.mentions, Number(r.counted), 'mentions equals the rows in source_skills');
    const share = r.mentions / r.of_postings;
    assert.equal(r.criticality, r.mentions < 2 ? null : share >= 0.6 ? 'high' : share >= 0.25 ? 'medium' : 'low');
    if (r.criticality) bands.add(r.criticality);
  }
  assert.deepEqual([...bands].sort(), ['high', 'low', 'medium'], 'the sample has all three bands');
});

db('two fixtures never collide, and a fixture can be asked for a different size', async (p) => {
  const a = await publishedCourse(p);
  const b = await publishedCourse(p, { sections: 1, chaptersPerSection: 2, postings: 8 });
  assert.notEqual(a.roleId, b.roleId);
  assert.equal(b.chapterIds.length, 2);
  assert.equal(b.sourceIds.length, 8);
  assert.equal(await count(p, `SELECT count(*) FROM courses WHERE status = 'ready' AND id = ANY($1)`, [[a.courseId, b.courseId]]), 2);
});

db('a pending course has proposed sources, a not-used near-match, no versions, and belongs to its requester', async (p) => {
  const c = await pendingCourse(p);
  const course = (await p.query(`SELECT status, requested_by, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.equal(course.status, 'awaiting_approval');
  assert.equal(course.requested_by, c.requesterId);
  assert.equal(course.published_version, null);
  assert.equal(await count(p, `SELECT count(*) FROM course_versions WHERE course_id = $1`, [c.courseId]), 0);
  assert.equal(await count(p, `SELECT count(*) FROM course_sources WHERE course_id = $1 AND state = 'proposed' AND use = 'pool'`, [c.courseId]), 8);
  const unused = (await p.query(`SELECT reason FROM course_sources WHERE course_id = $1 AND use = 'not_used'`, [c.courseId])).rows;
  assert.equal(unused.length, 1);
  assert.ok(unused[0].reason);
});

db('a private course comes from a pasted description: a private source and concept, owner set, nothing counted', async (p) => {
  const c = await privateCourse(p);
  const course = (await p.query(`SELECT status, visibility, owner_account_id FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([course.status, course.visibility, course.owner_account_id], ['ready', 'private', c.ownerId]);
  const paste = (await p.query(`SELECT origin, url, visibility, owner_account_id, counts_for_criticality FROM sources WHERE id = $1`, [c.pasteSourceId])).rows[0];
  assert.deepEqual([paste.origin, paste.url, paste.visibility, paste.owner_account_id, paste.counts_for_criticality], ['user_paste', null, 'private', c.ownerId, false]);
  assert.equal((await p.query(`SELECT visibility FROM role_concepts WHERE id = $1`, [c.privateConceptId])).rows[0].visibility, 'private');
  assert.equal((await p.query(`SELECT from_reader_source FROM course_concepts WHERE course_id = $1 AND concept_id = $2`, [c.courseId, c.privateConceptId])).rows[0].from_reader_source, true);
  assert.equal(await count(p, `SELECT count(*) FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [c.ownerId, c.courseId]), 1);
});

db('a withdrawn course keeps its live version and carries a note for its readers', async (p) => {
  const c = await withdrawnCourse(p, { note: 'This course is being corrected.' });
  const course = (await p.query(`SELECT status, withdrawn_at, withdrawal_note, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.equal(course.status, 'withdrawn');
  assert.ok(course.withdrawn_at);
  assert.equal(course.withdrawal_note, 'This course is being corrected.');
  assert.equal(course.published_version, c.versionId);
});

db('readers: an enrolment with read chapters, a quiz result and a last-active time; many readers at once', async (p) => {
  const c = await publishedCourse(p);
  const r = await enrolReader(p, c, { readChapters: 2, lastActiveAt: '2026-09-20T00:00:00.000Z', quizBest: 2 });
  assert.equal(await count(p, `SELECT count(*) FROM course_progress WHERE account_id = $1`, [r.accountId]), 2);
  assert.equal((await p.query(`SELECT last_active_at FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [r.accountId, c.courseId])).rows[0].last_active_at.toISOString(), '2026-09-20T00:00:00.000Z');
  assert.equal((await p.query(`SELECT best_score FROM section_quiz_results WHERE account_id = $1`, [r.accountId])).rows[0].best_score, 2);
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await enrolReader(p, c));
  assert.equal(await count(p, `SELECT count(*) FROM course_inputs WHERE course_id = $1`, [c.courseId]), 6);
});

db('a flag fixture freezes the text it flagged', async (p) => {
  const c = await publishedCourse(p);
  const reader = await enrolReader(p, c);
  const flagId = await flagChapter(p, c, reader.accountId, { reason: 'outdated' });
  const f = (await p.query(`SELECT target_type, target_id, snapshot, status, version_id, created_at FROM course_flags WHERE id = $1`, [flagId])).rows[0];
  assert.deepEqual([f.target_type, f.target_id, f.status, f.version_id], ['chapter', c.chapterIds[0], 'open', c.versionId]);
  assert.ok(f.snapshot.length > 0);
  assert.equal(f.created_at.toISOString(), NOW);
});

db('the source helper never counts a pasted description by default, and counts a researched or linked posting', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  const paste = await source(p, r, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: owner });
  const researched = await source(p, r);
  const linked = await source(p, r, { origin: 'user_url', found_via: 'user' });
  const counts = async (id: string) => (await p.query(`SELECT counts_for_criticality FROM sources WHERE id = $1`, [id])).rows[0].counts_for_criticality;
  assert.equal(await counts(paste), false);
  assert.equal(await counts(researched), true);
  assert.equal(await counts(linked), true);
});
