// Plan 16, phase 2, step 8: what the owner can do with courses from the moderation tool (spec 16, decisions 14, 21 and 28): see the queue of
// flags, failed runs and withdrawn courses; read a flag with its frozen copy; dismiss it; edit a chapter; withdraw a course; mark corrections
// complete (which runs the checks and republishes on a pass); audit the claim excerpts; and edit the tracked list. Every action is logged.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, enrolReader, flagChapter, publishedCourse, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createCourseModeration, type CourseChecker } from './courseModeration.ts';
import { createTrackedCompanies } from './trackedCompanies.ts';
import { createVersionStore } from './versions.ts';
import { runModerate } from '../moderate.ts';
import { createModeration } from '../moderation.ts';

const { db } = useCourseDb('coursemod', { reset: ['course_flags', 'moderation_log', 'course_runs'] });
const T = new Date('2026-10-20T09:00:00.000Z');
const pass: CourseChecker = async () => ({ ok: true, reasons: [] });
const fail: CourseChecker = async () => ({ ok: false, reasons: ['a claim about money has no supporting source'] });
const mod = (p: import('pg').Pool, checker?: CourseChecker) => createCourseModeration(p, { checker, now: () => T });
const log = async (p: import('pg').Pool) => (await p.query(`SELECT action, actor, reason, detail FROM moderation_log ORDER BY id`)).rows;
const courseStatus = async (p: import('pg').Pool, id: string) => (await p.query(`SELECT status, withdrawal_note, published_version FROM courses WHERE id = $1`, [id])).rows[0];

db('Scenario: the queue shows open flags, failed runs and withdrawn courses', async (p) => {
  const live = await publishedCourse(p);
  const reader = await account(p);
  await flagChapter(p, live, reader, { reason: 'inaccurate' });
  const failed = await publishedCourse(p);
  await p.query(`UPDATE courses SET status = 'failed', failure_reason = 'qa_failed', published_version = NULL WHERE id = $1`, [failed.courseId]);
  await p.query(`UPDATE course_versions SET status = 'failed' WHERE course_id = $1`, [failed.courseId]);
  await p.query(`INSERT INTO course_runs (course_id, kind, stage, error, started_at, finished_at) VALUES ($1, 'generation', 'check', 'chapter 3 failed the scope check twice', $2, $2)`, [failed.courseId, T]);
  const w = await withdrawnCourse(p);

  const q = await mod(p).queue();
  assert.equal(q.flags.length, 1);
  assert.deepEqual([q.flags[0]!.course_id, q.flags[0]!.reason, q.flags[0]!.target_type], [live.courseId, 'inaccurate', 'chapter']);
  assert.deepEqual(q.failedRuns.map((r) => [r.course_id, r.error]), [[failed.courseId, 'chapter 3 failed the scope check twice']]);
  assert.deepEqual(q.withdrawn.map((x) => x.course_id), [w.courseId]);
});

db('a flag is shown with its frozen copy, the chapter as it is now, and how many readers have flagged it', async (p) => {
  const c = await publishedCourse(p);
  const [a, b] = [await account(p), await account(p)];
  const id = await flagChapter(p, c, a, { reason: 'outdated' });
  await flagChapter(p, c, b);
  const v2 = await createVersionStore(p, () => T).start(c.courseId);
  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Rewritten', 'Brand new text.')`, [c.chapterIds[0], v2.id]);
  await createVersionStore(p, () => T).publish(v2.id);
  const shown = await mod(p).showFlag(id);
  assert.match(shown!.snapshot, /chapter 1/);
  assert.equal(shown!.current_text, 'Rewritten\n\nBrand new text.');
  assert.deepEqual([shown!.open_readers, shown!.reason, shown!.status], [2, 'outdated', 'open']);
  assert.equal(await mod(p).showFlag('00000000-0000-4000-8000-000000000000'), undefined);
  assert.equal(await mod(p).showFlag('nope'), undefined);
});

db('dismissing a flag handles it, can lift the review notice, and is logged', async (p) => {
  const c = await publishedCourse(p);
  const readers = [await account(p), await account(p), await account(p)];
  const ids: string[] = [];
  for (const r of readers) ids.push(await flagChapter(p, c, r));
  await p.query(`UPDATE course_chapters SET status = 'under_review' WHERE id = $1`, [c.chapterIds[0]]);

  assert.equal(await mod(p).dismissFlag(ids[0]!, 'not an error'), true);
  const f = (await p.query(`SELECT status, action, handled_at FROM course_flags WHERE id = $1`, [ids[0]])).rows[0];
  assert.deepEqual([f.status, f.action, f.handled_at.toISOString()], ['handled', 'dismissed', T.toISOString()]);
  assert.equal((await p.query(`SELECT status FROM course_chapters WHERE id = $1`, [c.chapterIds[0]])).rows[0].status, 'live', 'two open readers: no longer under review');
  assert.equal(await mod(p).dismissFlag(ids[0]!, 'again'), false, 'already handled');
  assert.equal(await mod(p).dismissFlag('nope', 'x'), false);
  assert.deepEqual((await log(p)).map((e) => [e.action, e.actor, e.reason]), [['course_flag_dismiss', 'owner', 'not an error']]);
});

db('Scenario: withdrawing a ready course gives readers a notice, handles its flags and is logged; only a ready course can be withdrawn', async (p) => {
  const c = await publishedCourse(p);
  const reader = await account(p);
  const flagId = await flagChapter(p, c, reader);
  assert.equal(await mod(p).withdraw(c.courseId, 'This course is being corrected.', 'wrong advice on tax'), 'ok');
  const s = await courseStatus(p, c.courseId);
  assert.deepEqual([s.status, s.withdrawal_note, s.published_version], ['withdrawn', 'This course is being corrected.', c.versionId]);
  assert.equal((await p.query(`SELECT withdrawn_at FROM courses WHERE id = $1`, [c.courseId])).rows[0].withdrawn_at.toISOString(), T.toISOString());
  assert.deepEqual((await p.query(`SELECT status, action FROM course_flags WHERE id = $1`, [flagId])).rows[0], { status: 'handled', action: 'withdrawn' });
  assert.equal(await mod(p).withdraw(c.courseId, 'again', ''), 'not_ready');
  assert.equal(await mod(p).withdraw('00000000-0000-4000-8000-000000000000', 'x', ''), 'not_found');
  assert.equal(await mod(p).withdraw(c.courseId, '', ''), 'not_ready');
  const entries = await log(p);
  assert.deepEqual([entries[0]!.action, entries[0]!.reason, entries[0]!.detail], ['course_withdraw', 'wrong advice on tax', { course_id: c.courseId, note: 'This course is being corrected.' }]);
});

db('a withdrawal needs a notice for readers', async (p) => {
  const c = await publishedCourse(p);
  assert.equal(await mod(p).withdraw(c.courseId, '   ', 'x'), 'invalid');
  assert.equal((await courseStatus(p, c.courseId)).status, 'ready');
});

db('Scenario: editing a chapter starts a correction version, keeps the live text live, and records a change for the changelog', async (p) => {
  const c = await publishedCourse(p);
  assert.equal(await mod(p).editChapter(c.chapterIds[0]!, 'The corrected words.'), 'ok');
  assert.equal(await mod(p).editChapter(c.chapterIds[1]!, 'And another.', 'A better title'), 'ok');
  const v = (await p.query(`SELECT id, version, status FROM course_versions WHERE course_id = $1 AND status = 'building'`, [c.courseId])).rows;
  assert.equal(v.length, 1, 'one correction version, shared by both edits');
  assert.equal(v[0].version, 2);
  const texts = (await p.query(`SELECT chapter_id, title, body FROM chapter_texts WHERE version_id = $1 ORDER BY body`, [v[0].id])).rows;
  assert.deepEqual(texts.map((t) => [t.title, t.body]), [['A better title', 'And another.'], ['Chapter 1', 'The corrected words.']], 'the title is kept unless given');
  assert.match((await p.query(`SELECT body FROM chapter_texts WHERE chapter_id = $1 AND version_id = $2`, [c.chapterIds[0], c.versionId])).rows[0].body, /chapter 1/, 'readers still have the old text');
  const changes = (await p.query(`SELECT kind, published_at FROM course_changes WHERE version_id = $1`, [v[0].id])).rows;
  assert.deepEqual(changes.map((x) => [x.kind, x.published_at]), [['chapter_corrected', null], ['chapter_corrected', null]]);
  await mod(p).editChapter(c.chapterIds[0]!, 'Edited twice.');
  assert.equal((await p.query(`SELECT count(*) FROM course_changes WHERE version_id = $1`, [v[0].id])).rows[0].count, '2', 'one change per chapter');
});

db('editing refuses an empty or huge body, an unknown chapter, a removed chapter, and a course that is not ready or withdrawn', async (p) => {
  const c = await publishedCourse(p);
  assert.equal(await mod(p).editChapter(c.chapterIds[0]!, '   '), 'invalid');
  assert.equal(await mod(p).editChapter(c.chapterIds[0]!, 'x'.repeat(20001)), 'invalid');
  assert.equal(await mod(p).editChapter('00000000-0000-4000-8000-000000000000', 'x'), 'not_found');
  assert.equal(await mod(p).editChapter('nope', 'x'), 'not_found');
  await p.query(`UPDATE course_chapters SET status = 'removed' WHERE id = $1`, [c.chapterIds[2]]);
  assert.equal(await mod(p).editChapter(c.chapterIds[2]!, 'x'), 'not_found');
  await p.query(`UPDATE courses SET status = 'building' WHERE id = $1`, [c.courseId]);
  assert.equal(await mod(p).editChapter(c.chapterIds[0]!, 'x'), 'not_editable');
  assert.equal((await p.query(`SELECT count(*) FROM course_versions WHERE course_id = $1 AND status = 'building'`, [c.courseId])).rows[0].count, '0');
});

db('Scenario: marking corrections complete runs the checks and, on a pass, republishes at once', async (p) => {
  const c = await publishedCourse(p);
  const reader = await account(p);
  const flagId = await flagChapter(p, c, reader);
  await mod(p).editChapter(c.chapterIds[0]!, 'The corrected words.');
  const checked: string[] = [];
  const result = await mod(p, async (id) => (checked.push(id), { ok: true, reasons: [] })).markCorrected(c.courseId);
  assert.equal(result.kind, 'published');
  assert.equal(checked.length, 1);
  const s = await courseStatus(p, c.courseId);
  assert.equal(s.status, 'ready');
  assert.notEqual(s.published_version, c.versionId);
  assert.deepEqual((await p.query(`SELECT status, action FROM course_flags WHERE id = $1`, [flagId])).rows[0], { status: 'handled', action: 'edited' }, 'its flag is handled');
  assert.notEqual((await p.query(`SELECT published_at FROM course_changes WHERE course_id = $1`, [c.courseId])).rows[0].published_at, null, 'the changelog entry is now visible');
  assert.deepEqual((await log(p)).map((e) => e.action), ['course_edit_chapter', 'course_correction_published']);
});

db('Scenario: if the checks fail, nothing is republished, the edits wait for another try, and the reasons are logged', async (p) => {
  const c = await withdrawnCourse(p, { note: 'Being corrected.' });
  await mod(p).editChapter(c.chapterIds[0]!, 'A first attempt.');
  const bad = await mod(p, fail).markCorrected(c.courseId);
  assert.deepEqual(bad, { kind: 'checks_failed', reasons: ['a claim about money has no supporting source'] });
  assert.equal((await courseStatus(p, c.courseId)).status, 'withdrawn');
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE course_id = $1 AND version = 2`, [c.courseId])).rows[0].status, 'building', 'the edits are kept');
  await mod(p).editChapter(c.chapterIds[0]!, 'A better second attempt.');
  assert.equal((await mod(p, pass).markCorrected(c.courseId)).kind, 'published');
  const s = await courseStatus(p, c.courseId);
  assert.deepEqual([s.status, s.withdrawal_note], ['ready', null]);
  assert.deepEqual((await log(p)).map((e) => e.action), ['course_edit_chapter', 'course_correction_failed', 'course_edit_chapter', 'course_correction_published']);
});

db('without a checker marking corrections complete refuses, and with nothing edited there is nothing to publish', async (p) => {
  const c = await publishedCourse(p);
  assert.equal((await mod(p, pass).markCorrected(c.courseId)).kind, 'nothing_to_publish');
  await mod(p).editChapter(c.chapterIds[0]!, 'Edited.');
  assert.equal((await mod(p).markCorrected(c.courseId)).kind, 'no_checker', 'fail closed until the checks exist');
  assert.equal((await courseStatus(p, c.courseId)).published_version, c.versionId);
  assert.equal((await mod(p, pass).markCorrected('00000000-0000-4000-8000-000000000000')).kind, 'not_found');
});

db('regenerating a chapter queues a correction run and handles the chapter\'s open flags', async (p) => {
  const c = await publishedCourse(p);
  const id = await flagChapter(p, c, await account(p));
  assert.equal(await mod(p).regenerate(c.chapterIds[0]!, 'rewrite from scratch'), true);
  const run = (await p.query(`SELECT kind, stage, percent, finished_at FROM course_runs WHERE course_id = $1 AND kind = 'correction'`, [c.courseId])).rows;
  assert.deepEqual(run, [{ kind: 'correction', stage: `regenerate:${c.chapterIds[0]}`, percent: 0, finished_at: null }]);
  assert.deepEqual((await p.query(`SELECT status, action FROM course_flags WHERE id = $1`, [id])).rows[0], { status: 'handled', action: 'regenerated' });
  assert.equal(await mod(p).regenerate('nope', ''), false);
});

db('the owner can audit every claim excerpt of a course', async (p) => {
  const c = await publishedCourse(p);
  await p.query(`INSERT INTO claim_excerpts (course_id, chapter_id, version_id, claim, category, excerpt, url) VALUES ($1, $2, $3, 'Tax is due in April.', 'money', 'Returns are due on 15 April.', 'https://irs.example.com/p')`, [c.courseId, c.chapterIds[0], c.versionId]);
  const rows = await mod(p).excerpts(c.courseId);
  assert.deepEqual(rows.map((r) => [r.category, r.claim, r.excerpt, r.url, r.chapter_id]), [['money', 'Tax is due in April.', 'Returns are due on 15 April.', 'https://irs.example.com/p', c.chapterIds[0]]]);
  assert.deepEqual(await mod(p).excerpts('nope'), []);
});

db('the moderation tool\'s commands do these things and print what the owner needs', async (p) => {
  const c = await publishedCourse(p);
  const reader = await account(p);
  const flagId = await flagChapter(p, c, reader);
  const cm = mod(p, pass);
  const tracked = createTrackedCompanies(p, () => T);
  const out: string[] = [];
  const run = (...args: string[]) => runModerate(args, createModeration(p), (line) => out.push(line), () => T, { courses: cm, tracked });

  assert.equal(await run('course-queue'), 0);
  assert.ok(out.some((l) => l.includes(flagId)));
  out.length = 0;
  assert.equal(await run('course-flag', flagId), 0);
  assert.ok(out.join('\n').includes('inaccurate'));
  assert.equal(await run('course-edit', c.chapterIds[0]!, 'The', 'corrected', 'words.'), 0);
  assert.equal(await run('course-corrected', c.courseId), 0);
  assert.equal(await run('course-withdraw', c.courseId, 'Being', 'corrected.'), 0);
  assert.equal((await courseStatus(p, c.courseId)).withdrawal_note, 'Being corrected.');
  assert.equal(await run('course-withdraw', c.courseId, 'again'), 1, 'not ready: nothing to do');
  assert.equal(await run('course-excerpts', c.courseId), 0);
  assert.equal(await run('course-flag'), 2, 'a missing argument prints the usage');
  assert.equal(await run('tracked-add', 'jobs.new.example.com', 'New', 'Co'), 0);
  assert.equal(await run('tracked-status', 'jobs.new.example.com', 'trusted'), 0);
  assert.equal(await run('tracked-status', 'jobs.new.example.com', 'great'), 2);
  assert.equal(await run('tracked-status', 'nobody.example.com', 'blocked'), 1);
  out.length = 0;
  assert.equal(await run('tracked-list'), 0);
  assert.ok(out.some((l) => l.includes('jobs.new.example.com') && l.includes('trusted')));
  assert.ok((await log(p)).some((e) => e.action === 'tracked_status'));
});
