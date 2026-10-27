// Plan 16: what a reader does in a course: reading chapters, taking section quizzes, flagging, the changelog and asking for a refresh
// (spec 16, section 5). Each follows the same access rules as reading; reading and quizzes keep the reader active.
import type pg from 'pg';
import { enrolReader } from './enrol.ts';
import { listRefreshNeeded } from './listRefresh.ts';
import type { CourseReads, Read } from './reads.ts';
import { createCourseRequests, windowRetry, type LimitCode } from './requests.ts';
import type { createCourseSettings } from './settings.ts';
import { createCourseStore } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
export const FLAG_REASONS = ['inaccurate', 'outdated', 'off_topic', 'inappropriate'] as const;
const TARGETS = ['chapter', 'concept', 'question'] as const;
/** Different readers' open flags on one chapter that put it under review. */
export const REVIEW_AFTER_READERS = 3;

const ok = <T>(body: T): Read<T> => ({ kind: 'ok', body });
const notFound = { kind: 'not_found' } as const;
export type Acted<T> = Read<T> | { kind: 'invalid'; error: string } | { kind: 'limited'; code: LimitCode | 'flag_limit'; retryAt: Date | null };

export function createCourseActivity(pool: pg.Pool, reads: CourseReads, settings: ReturnType<typeof createCourseSettings>, now: () => Date = () => new Date()) {
  const store = createCourseStore(pool);
  const requests = createCourseRequests(pool, settings, now);

  return {
    /**
     * A reader removes a course from their list: their progress, quiz results, seen marker and input go. A shared course stays; a private one
     * is deleted with its pasted description and the concepts only it asked for; a request still waiting for approval is cancelled.
     */
    async leave(accountId: string, courseId: string): Promise<Read<null>> {
      if (!UUID.test(courseId)) return notFound;
      const c = (
        await pool.query(
          `SELECT c.status, c.visibility, c.owner_account_id, c.requested_by,
                  EXISTS (SELECT 1 FROM course_inputs i WHERE i.account_id = $1 AND i.course_id = c.id) AS enrolled
           FROM courses c WHERE c.id = $2`,
          [accountId, courseId],
        )
      ).rows[0];
      const pending = c && (c.status === 'finding_sources' || c.status === 'awaiting_approval') && c.requested_by === accountId;
      const mine = c && c.visibility === 'private' && c.owner_account_id === accountId;
      if (!c || !(c.enrolled || pending || mine)) return notFound;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM course_progress WHERE account_id = $1 AND chapter_id IN (SELECT ch.id FROM course_chapters ch JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = $2)`, [accountId, courseId]);
        await client.query(`DELETE FROM section_quiz_results WHERE account_id = $1 AND section_id IN (SELECT id FROM course_sections WHERE course_id = $2)`, [accountId, courseId]);
        await client.query(`DELETE FROM course_seen WHERE account_id = $1 AND course_id = $2`, [accountId, courseId]);
        await client.query(`DELETE FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [accountId, courseId]);
        if (mine) {
          await client.query(`DELETE FROM sources WHERE visibility = 'private' AND owner_account_id = $1 AND id IN (SELECT source_id FROM course_sources WHERE course_id = $2)`, [accountId, courseId]);
          // An independent list's private concepts carry its id and go with the course below; any other private concept is found through the course's own links.
          await client.query(`DELETE FROM role_concepts WHERE visibility = 'private' AND owner_account_id = $1 AND course_id IS NULL AND id IN (SELECT concept_id FROM course_concepts WHERE course_id = $2)`, [accountId, courseId]);
          await client.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
        } else if (pending) {
          await client.query(`UPDATE courses SET status = 'cancelled' WHERE id = $1`, [courseId]);
          await client.query(`UPDATE course_requests SET outcome = 'cancelled' WHERE course_id = $1 AND kind = 'source_search' AND outcome = 'started'`, [courseId]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return ok(null);
    },

    /** The reader opened a list: it counts as used now, so the list screen puts it first. Joins nothing: a reader who has not joined the course is told it is not found. */
    async open(accountId: string, courseId: string): Promise<Read<null>> {
      if (!UUID.test(courseId)) return notFound;
      const touched = await pool.query(`UPDATE course_inputs SET last_active_at = $3 WHERE account_id = $1 AND course_id = $2`, [accountId, courseId, now()]);
      return touched.rowCount ? ok(null) : notFound;
    },

    /** The reader names a list for themselves (1 to 80 characters, one line), or clears the name (null) to go back to the default. Other readers of a shared list are not affected. */
    async rename(accountId: string, courseId: string, title: unknown): Promise<Acted<null>> {
      if (title !== null && (typeof title !== 'string' || /[\u0000-\u001f\u007f]/.test(title) || title.trim().length < 1 || title.trim().length > 80)) return { kind: 'invalid', error: 'invalid_title' };
      if (!UUID.test(courseId)) return notFound;
      const done = await pool.query(`UPDATE course_inputs SET title = $3 WHERE account_id = $1 AND course_id = $2`, [accountId, courseId, title === null ? null : (title as string).trim()]);
      return done.rowCount ? ok(null) : notFound;
    },

    /** Marks a chapter read. Idempotent. */
    async markRead(accountId: string, courseId: string, chapterId: string): Promise<Read<null>> {
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;
      if (!UUID.test(chapterId) || !(await store.publishedChapter(courseId, chapterId))) return notFound;
      await pool.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [accountId, chapterId, now()]);
      await enrolReader(pool, accountId, courseId, '', now());
      return ok(null);
    },

    /** Grades a section quiz against the published version's, and keeps the best score and the number of attempts. */
    async gradeQuiz(accountId: string, courseId: string, sectionId: string, answers: unknown): Promise<Acted<Record<string, unknown>>> {
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;
      if (!UUID.test(sectionId) || !(await pool.query(`SELECT 1 FROM course_sections WHERE id = $1 AND course_id = $2`, [sectionId, courseId])).rowCount) return notFound;
      const quiz = await store.publishedQuiz(sectionId);
      if (!quiz) return notFound;
      const questions = quiz.questions as Array<{ options: string[]; correct_index: number }>;
      const fits = Array.isArray(answers) && answers.length === questions.length && answers.every((x, i) => Number.isInteger(x) && x >= 0 && x < questions[i]!.options.length);
      if (!fits) return { kind: 'invalid', error: 'invalid_answers' };
      const results = questions.map((q, i) => ({ correct: (answers as number[])[i] === q.correct_index, correct_index: q.correct_index }));
      const score = results.filter((r) => r.correct).length;
      const { rows } = await pool.query(
        `INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (account_id, section_id) DO UPDATE SET best_score = GREATEST(section_quiz_results.best_score, EXCLUDED.best_score), attempts = section_quiz_results.attempts + 1, last_taken_at = EXCLUDED.last_taken_at
         RETURNING best_score, attempts`,
        [accountId, sectionId, score, now()],
      );
      await enrolReader(pool, accountId, courseId, '', now());
      return ok({ section_id: sectionId, score, total: questions.length, best_score: rows[0].best_score, attempts: rows[0].attempts, results });
    },

    /** A reader flags a chapter, a concept or a question. The flag keeps a frozen copy; three different readers put a chapter under review. */
    async flag(accountId: string, input: Record<string, unknown>): Promise<Acted<{ ok: true }>> {
      const { course_id: courseId, target_type: type, target_id: target, reason, note } = input;
      if (typeof courseId !== 'string' || !TARGETS.includes(type as never) || typeof target !== 'string' || !FLAG_REASONS.includes(reason as never)) return { kind: 'invalid', error: 'invalid_flag' };
      if (note !== undefined && (typeof note !== 'string' || note.length > 500)) return { kind: 'invalid', error: 'invalid_flag' };
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;

      let snapshot: string | null = null;
      if (type === 'chapter') {
        const ch = UUID.test(target) ? await store.publishedChapter(courseId, target) : null;
        if (ch) snapshot = `${ch.title}\n\n${ch.body}`;
      } else if (type === 'concept') {
        const k = UUID.test(target) ? (await pool.query(`SELECT k.name, k.plain_explanation FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 AND cc.concept_id = $2`, [courseId, target])).rows[0] : null;
        if (k) snapshot = `${k.name}\n\n${k.plain_explanation}`;
      } else {
        const m = /^([0-9a-f-]{36}):(\d{1,3})$/i.exec(target);
        const section = m && UUID.test(m[1]!) && (await pool.query(`SELECT 1 FROM course_sections WHERE id = $1 AND course_id = $2`, [m[1], courseId])).rowCount ? m[1]! : null;
        const question = section ? ((await store.publishedQuiz(section))?.questions as Array<{ prompt: string; options: string[] }> | undefined)?.[Number(m![2])] : undefined;
        if (question) snapshot = `${question.prompt}\n${question.options.map((o) => `- ${o}`).join('\n')}`;
      }
      if (snapshot === null) return notFound;

      // The same reader flagging the same thing the same (UTC) day is thanked, and nothing new is stored or counted.
      const dup = await pool.query(
        `SELECT 1 FROM course_flags WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND (created_at AT TIME ZONE 'UTC')::date = ($4::timestamptz AT TIME ZONE 'UTC')::date`,
        [accountId, type, target, now()],
      );
      if (dup.rowCount) return ok({ ok: true });

      const limit = (await settings.get()).perReader.flagsPerDay;
      const recent = (await pool.query(`SELECT created_at FROM course_flags WHERE reporter_id = $1 AND created_at > $2`, [accountId, new Date(now().getTime() - DAY)])).rows.map((r) => r.created_at as Date);
      const retry = windowRetry(recent, limit, DAY);
      if (retry !== null) return { kind: 'limited', code: 'flag_limit', retryAt: retry ?? null };

      try {
        await pool.query(
          `INSERT INTO course_flags (reporter_id, course_id, version_id, target_type, target_id, reason, note, snapshot, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [accountId, courseId, (await pool.query(`SELECT published_version FROM courses WHERE id = $1`, [courseId])).rows[0].published_version, type, target, reason, note ?? '', snapshot, now()],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error; // lost a race with the same reader's identical flag
        return ok({ ok: true });
      }
      if (type === 'chapter') {
        const readers = Number((await pool.query(`SELECT count(DISTINCT reporter_id) FROM course_flags WHERE course_id = $1 AND target_type = 'chapter' AND target_id = $2 AND status = 'open' AND reporter_id IS NOT NULL`, [courseId, target])).rows[0].count);
        if (readers >= REVIEW_AFTER_READERS) await pool.query(`UPDATE course_chapters SET status = 'under_review' WHERE id = $1 AND status = 'live'`, [target]);
      }
      return ok({ ok: true });
    },

    /** The published changes after a version, newest first. */
    async changes(accountId: string, courseId: string, since: number): Promise<Read<Record<string, unknown>>> {
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;
      const current = (await pool.query(`SELECT v.version FROM courses c JOIN course_versions v ON v.id = c.published_version WHERE c.id = $1`, [courseId])).rows[0].version as number;
      const rows = (
        await pool.query(
          `SELECT ch.id, v.version, ch.kind, ch.target, ch.summary, ch.published_at FROM course_changes ch JOIN course_versions v ON v.id = ch.version_id
           WHERE ch.course_id = $1 AND ch.published_at IS NOT NULL AND v.version > $2 ORDER BY v.version DESC, ch.created_at, ch.id`,
          [courseId, since],
        )
      ).rows;
      return ok({ current_version: current, changes: rows.map((r) => ({ id: r.id, version: r.version, kind: r.kind, target: r.target, summary: r.summary, published_at: r.published_at.toISOString() })) });
    },

    /** Remembers that the reader has seen the changelog up to a version. It never goes backwards. */
    async seen(accountId: string, courseId: string, version: unknown): Promise<Acted<null>> {
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return { kind: 'invalid', error: 'invalid_version' };
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;
      const current = (await pool.query(`SELECT v.version FROM courses c JOIN course_versions v ON v.id = c.published_version WHERE c.id = $1`, [courseId])).rows[0].version as number;
      if (version > current) return { kind: 'invalid', error: 'version_ahead' };
      await enrolReader(pool, accountId, courseId, '', now());
      await pool.query(
        `INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, course_id) DO UPDATE SET seen_version = GREATEST(course_seen.seen_version, EXCLUDED.seen_version)`,
        [accountId, courseId, version],
      );
      return ok(null);
    },

    /** A reader asks for an earlier refresh: logged, and a refresh run queued for the pipeline. */
    async refresh(accountId: string, courseId: string): Promise<Acted<{ course_id: string; status: 'queued' | 'up_to_date'; repeat?: true; started?: boolean }>> {
      const a = await reads.access(accountId, courseId);
      if (a.kind !== 'ok') return a;
      if (a.body.mode === 'list') {
        if (!(await pool.query(`SELECT 1 FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [accountId, courseId])).rowCount) return notFound; // only a reader of the list can ask for its check
        // A list is checked against the reference library. Nothing new there: the answer is at once, and the list is stamped as checked. Otherwise a check is queued for the runner.
        if (!(await listRefreshNeeded(pool, courseId))) {
          await pool.query(`UPDATE courses SET last_checked_at = $2 WHERE id = $1`, [courseId, now()]);
          return ok({ course_id: courseId, status: 'up_to_date' });
        }
        if ((await pool.query(`SELECT 1 FROM course_runs WHERE course_id = $1 AND kind = 'refresh' AND finished_at IS NULL`, [courseId])).rowCount) return ok({ course_id: courseId, status: 'queued', repeat: true });
        const asked = await requests.listRefresh(accountId, a.body.roleId, courseId);
        if (!asked.ok) return asked.code === 'courses_off' ? notFound : { kind: 'limited', code: asked.code, retryAt: asked.retryAt };
        await pool.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'refresh', $2, 'queued', 0, $3)`, [courseId, accountId, now()]);
        return ok({ course_id: courseId, status: 'queued', started: true });
      }
      const d = await requests.refresh(accountId, a.body.roleId, courseId);
      if (!d.ok) return d.code === 'courses_off' ? notFound : { kind: 'limited', code: d.code, retryAt: d.retryAt };
      if (d.alreadyChecked) return ok({ course_id: courseId, status: 'up_to_date' });
      if (d.repeat) return ok({ course_id: courseId, status: 'queued', repeat: true });
      await pool.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'refresh', $2, 'queued', 0, $3)`, [courseId, accountId, now()]);
      return ok({ course_id: courseId, status: 'queued', started: true });
    },
  };
}

export type CourseActivity = ReturnType<typeof createCourseActivity>;
