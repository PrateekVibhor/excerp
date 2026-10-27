// Plan 16, phase 2, step 8: how long course data is kept (spec 16, section 4). Handled flags go 90 days after they were handled; the request
// log goes after 90 days; unapproved requests close after seven days. A course itself never expires, withdrawn or not.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, enrolReader, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { pendingCourse } from '../../testkit/courseFixtures.ts';
import { runCourseCleanup } from './retention.ts';
import { createCourseSettings } from './settings.ts';

const { db } = useCourseDb('retention', { reset: ['course_requests', 'course_flags'] });
const DAY = 86_400_000;
const NOW = new Date('2026-12-01T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const cleanup = (p: import('pg').Pool) => runCourseCleanup(p, createCourseSettings(p), NOW);
const count = async (p: import('pg').Pool, sql: string, args: unknown[] = []) => Number((await p.query(sql, args)).rows[0].count);

async function flag(p: import('pg').Pool, c: Awaited<ReturnType<typeof publishedCourse>>, over: { status: 'open' | 'handled'; handledDaysAgo?: number }) {
  const reporter = await account(p);
  const handled = over.status === 'handled';
  const { rows } = await p.query(
    `INSERT INTO course_flags (reporter_id, course_id, version_id, target_type, target_id, reason, snapshot, status, action, handled_at, created_at)
     VALUES ($1, $2, $3, 'chapter', $4, 'inaccurate', 'frozen', $5, $6, $7, $8) RETURNING id`,
    [reporter, c.courseId, c.versionId, c.chapterIds[0], over.status, handled ? 'dismissed' : null, handled ? ago(over.handledDaysAgo ?? 0) : null, ago(200)],
  );
  return rows[0].id as string;
}

db('Scenario: a handled flag is deleted 90 days after it was handled; a newer one and an open one stay, however old', async (p) => {
  const c = await publishedCourse(p);
  const old = await flag(p, c, { status: 'handled', handledDaysAgo: 91 });
  const edge = await flag(p, c, { status: 'handled', handledDaysAgo: 90 });
  const recent = await flag(p, c, { status: 'handled', handledDaysAgo: 89 });
  const open = await flag(p, c, { status: 'open' });
  const result = await cleanup(p);
  assert.equal(result.deletedFlags, 2);
  const left = (await p.query(`SELECT id FROM course_flags`)).rows.map((r) => r.id as string).sort();
  assert.deepEqual(left, [recent, open].sort());
  void old; void edge;
});

db('the request log is kept 90 days', async (p) => {
  const a = await account(p);
  const c = await publishedCourse(p);
  const row = (days: number) => p.query(`INSERT INTO course_requests (account_id, role_id, course_id, kind, outcome, created_at) VALUES ($1, $2, $3, 'source_search', 'started', $4)`, [a, c.roleId, c.courseId, ago(days)]);
  await row(120);
  await row(91);
  await row(89);
  await row(1);
  assert.equal((await cleanup(p)).deletedRequests, 2);
  assert.equal(await count(p, `SELECT count(*) FROM course_requests WHERE account_id = $1`, [a]), 2);
});

db('Scenario: unapproved requests close after seven days; an approved or ready course is never touched', async (p) => {
  const requester = await account(p);
  const stale = await pendingCourse(p, { requesterId: requester });
  const fresh = await pendingCourse(p, { requesterId: requester });
  const building = await pendingCourse(p, { requesterId: requester });
  await p.query(`UPDATE courses SET status = 'building' WHERE id = $1`, [building.courseId]);
  await p.query(`UPDATE courses SET created_at = $2 WHERE id = ANY($1)`, [[stale.courseId, building.courseId], ago(8)]);
  await p.query(`UPDATE courses SET created_at = $2 WHERE id = $1`, [fresh.courseId, ago(6)]);
  assert.equal((await cleanup(p)).expiredAttempts, 1);
  const status = async (id: string) => (await p.query(`SELECT status, failure_reason FROM courses WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(await status(stale.courseId), { status: 'cancelled', failure_reason: 'expired' });
  assert.equal((await status(fresh.courseId)).status, 'awaiting_approval');
  assert.equal((await status(building.courseId)).status, 'building');
});

db('Scenario: a course never expires: a very old ready, withdrawn or dormant course keeps everything, and so do its excerpts and changes', async (p) => {
  const ready = await publishedCourse(p);
  const withdrawn = await withdrawnCourse(p);
  const dormant = await publishedCourse(p);
  await enrolReader(p, dormant, { lastActiveAt: ago(400).toISOString(), readChapters: 2, quizBest: 1 });
  await p.query(`UPDATE courses SET created_at = $2, generated_at = $2 WHERE id = ANY($1)`, [[ready.courseId, withdrawn.courseId, dormant.courseId], ago(700)]);
  await p.query(`INSERT INTO claim_excerpts (course_id, chapter_id, version_id, claim, category, excerpt, url, created_at) VALUES ($1, $2, $3, 'c', 'money', 'x', 'https://e.example.com', $4)`, [ready.courseId, ready.chapterIds[0], ready.versionId, ago(700)]);
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary, created_at, published_at) VALUES ($1, $2, 'chapter_added', 'old', $3, $3)`, [ready.courseId, ready.versionId, ago(700)]);
  const before = await count(p, `SELECT (SELECT count(*) FROM courses) + (SELECT count(*) FROM course_chapters) + (SELECT count(*) FROM chapter_texts) + (SELECT count(*) FROM claim_excerpts) + (SELECT count(*) FROM course_changes) + (SELECT count(*) FROM course_progress) + (SELECT count(*) FROM course_inputs) AS count`);
  await cleanup(p);
  const after = await count(p, `SELECT (SELECT count(*) FROM courses) + (SELECT count(*) FROM course_chapters) + (SELECT count(*) FROM chapter_texts) + (SELECT count(*) FROM claim_excerpts) + (SELECT count(*) FROM course_changes) + (SELECT count(*) FROM course_progress) + (SELECT count(*) FROM course_inputs) AS count`);
  assert.equal(after, before);
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [withdrawn.courseId])).rows[0].status, 'withdrawn');
});

db('the clean-up is safe to run again and again', async (p) => {
  const c = await publishedCourse(p);
  await flag(p, c, { status: 'handled', handledDaysAgo: 100 });
  const first = await cleanup(p);
  const second = await cleanup(p);
  assert.deepEqual([first.deletedFlags, second.deletedFlags, second.deletedRequests, second.expiredAttempts], [1, 0, 0, 0]);
});
