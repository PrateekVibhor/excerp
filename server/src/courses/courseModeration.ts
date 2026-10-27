// Plan 16: the owner's side of courses, used from the moderation tool (spec 16, decisions 14, 21 and 28). The owner sees what needs attention,
// reads a flag with its frozen copy, dismisses it, edits a chapter, withdraws a course, and marks corrections complete, which runs the checks
// and republishes on a pass. Every action is written to the moderation log. The checks themselves are the pipeline's (phase 4): until a checker
// is given, marking corrections complete refuses.
import type pg from 'pg';
import { REVIEW_AFTER_READERS } from './activity.ts';
import { createCourseStore } from './store.ts';
import { createVersionStore } from './versions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 20_000;

export type CourseChecker = (versionId: string) => Promise<{ ok: boolean; reasons: string[] }>;

export interface FlagSummary {
  id: string;
  course_id: string;
  course_title: string;
  target_type: string;
  target_id: string;
  reason: string;
  note: string;
  created_at: Date;
}

export function createCourseModeration(pool: pg.Pool, opts: { checker?: CourseChecker; now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const store = createCourseStore(pool);
  const versions = createVersionStore(pool, now);

  const log = (action: string, reason: string, detail?: unknown) =>
    pool.query(`INSERT INTO moderation_log (action, reason, actor, detail, created_at) VALUES ($1, $2, 'owner', $3::jsonb, $4)`, [action, reason, detail === undefined ? null : JSON.stringify(detail), now()]);

  /** A chapter comes out of review when fewer than three different readers still have an open flag on it. */
  async function settleReview(chapterId: string) {
    const readers = Number((await pool.query(`SELECT count(DISTINCT reporter_id) FROM course_flags WHERE target_type = 'chapter' AND target_id = $1 AND status = 'open' AND reporter_id IS NOT NULL`, [chapterId])).rows[0].count);
    if (readers < REVIEW_AFTER_READERS) await pool.query(`UPDATE course_chapters SET status = 'live' WHERE id = $1 AND status = 'under_review'`, [chapterId]);
  }

  async function chapterCourse(chapterId: string) {
    if (!UUID.test(chapterId)) return undefined;
    return (
      await pool.query(
        `SELECT ch.id, ch.status AS chapter_status, s.course_id, c.status AS course_status FROM course_chapters ch JOIN course_sections s ON s.id = ch.section_id JOIN courses c ON c.id = s.course_id WHERE ch.id = $1`,
        [chapterId],
      )
    ).rows[0] as { id: string; chapter_status: string; course_id: string; course_status: string } | undefined;
  }

  return {
    /** Anything the owner may want to look at: open flags, runs that failed, and courses that are withdrawn. */
    async queue() {
      const flags = (
        await pool.query<FlagSummary>(
          `SELECT f.id, f.course_id, c.title AS course_title, f.target_type, f.target_id, f.reason, f.note, f.created_at FROM course_flags f JOIN courses c ON c.id = f.course_id WHERE f.status = 'open' ORDER BY f.created_at, f.id`,
        )
      ).rows;
      const failedRuns = (
        await pool.query(
          `SELECT r.id, r.course_id, c.title AS course_title, r.kind, r.stage, r.error, r.started_at FROM course_runs r JOIN courses c ON c.id = r.course_id WHERE r.error IS NOT NULL ORDER BY r.started_at DESC, r.id DESC LIMIT 50`,
        )
      ).rows;
      const withdrawn = (await pool.query(`SELECT id AS course_id, title, withdrawal_note, withdrawn_at FROM courses WHERE status = 'withdrawn' ORDER BY withdrawn_at`)).rows;
      return { flags, failedRuns, withdrawn };
    },

    /** One flag with its frozen copy, the chapter as it reads now, and how many different readers have flagged it. */
    async showFlag(id: string) {
      if (!UUID.test(id)) return undefined;
      const f = (
        await pool.query(
          `SELECT f.id, f.course_id, c.title AS course_title, f.target_type, f.target_id, f.reason, f.note, f.snapshot, f.status, f.action, f.created_at FROM course_flags f JOIN courses c ON c.id = f.course_id WHERE f.id = $1`,
          [id],
        )
      ).rows[0];
      if (!f) return undefined;
      let current: string | null = null;
      if (f.target_type === 'chapter') {
        const ch = await store.publishedChapter(f.course_id, f.target_id);
        if (ch) current = `${ch.title}\n\n${ch.body}`;
      }
      const readers = Number((await pool.query(`SELECT count(DISTINCT reporter_id) FROM course_flags WHERE course_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'open' AND reporter_id IS NOT NULL`, [f.course_id, f.target_type, f.target_id])).rows[0].count);
      return { ...f, current_text: current, open_readers: readers } as typeof f & { current_text: string | null; open_readers: number };
    },

    /** Handles a flag as not an error. False if it is unknown or already handled. */
    async dismissFlag(id: string, why: string): Promise<boolean> {
      if (!UUID.test(id)) return false;
      const { rows } = await pool.query(`UPDATE course_flags SET status = 'handled', action = 'dismissed', handled_at = $2 WHERE id = $1 AND status = 'open' RETURNING target_type, target_id`, [id, now()]);
      if (!rows[0]) return false;
      if (rows[0].target_type === 'chapter') await settleReview(rows[0].target_id);
      await log('course_flag_dismiss', why, { flag_id: id });
      return true;
    },

    /** Withdraws a ready course: readers see the notice and no content, new readers cannot start it, refresh stops. Its open flags are handled. */
    async withdraw(courseId: string, note: string, why: string): Promise<'ok' | 'not_found' | 'not_ready' | 'invalid'> {
      if (!UUID.test(courseId)) return 'not_found';
      const c = (await pool.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0];
      if (!c) return 'not_found';
      if (c.status !== 'ready') return 'not_ready';
      if (note.trim() === '') return 'invalid';
      const done = await pool.query(`UPDATE courses SET status = 'withdrawn', withdrawn_at = $2, withdrawal_note = $3 WHERE id = $1 AND status = 'ready'`, [courseId, now(), note.trim()]);
      if (!done.rowCount) return 'not_ready';
      await pool.query(`UPDATE course_flags SET status = 'handled', action = 'withdrawn', handled_at = $2 WHERE course_id = $1 AND status = 'open'`, [courseId, now()]);
      await log('course_withdraw', why, { course_id: courseId, note: note.trim() });
      return 'ok';
    },

    /**
     * The owner's corrected text for a chapter. It goes into a correction version built beside the live one (the live text stays live until the
     * corrections are marked complete), with a changelog entry for the readers.
     */
    async editChapter(chapterId: string, body: string, title?: string): Promise<'ok' | 'not_found' | 'invalid' | 'not_editable'> {
      const ch = await chapterCourse(chapterId);
      if (!ch || ch.chapter_status === 'removed') return 'not_found';
      const text = body.trim();
      if (text === '' || text.length > MAX_BODY) return 'invalid';
      if (ch.course_status !== 'ready' && ch.course_status !== 'withdrawn') return 'not_editable';
      const building = (await pool.query(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'building'`, [ch.course_id])).rows[0];
      const versionId: string = building ? building.id : (await versions.start(ch.course_id)).id;
      const own = (await pool.query(`SELECT title FROM chapter_texts WHERE chapter_id = $1 AND version_id = $2`, [chapterId, versionId])).rows[0];
      const shown = own ?? (await store.publishedChapter(ch.course_id, chapterId));
      const name = title?.trim() || shown?.title || 'Chapter';
      await pool.query(
        `INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, $3, $4) ON CONFLICT (chapter_id, version_id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body`,
        [chapterId, versionId, name, text],
      );
      const seen = await pool.query(`SELECT 1 FROM course_changes WHERE version_id = $1 AND kind = 'chapter_corrected' AND target = $2`, [versionId, chapterId]);
      if (!seen.rowCount) await pool.query(`INSERT INTO course_changes (course_id, version_id, kind, target, summary, created_at) VALUES ($1, $2, 'chapter_corrected', $3, $4, $5)`, [ch.course_id, versionId, chapterId, `The chapter "${name}" was corrected.`, now()]);
      await log('course_edit_chapter', '', { course_id: ch.course_id, chapter_id: chapterId });
      return 'ok';
    },

    /**
     * The owner says the corrections are done. The checks run on the correction version; on a pass it is published at once (clearing a
     * withdrawal) and the flags on the edited chapters are handled; on a fail nothing changes and the edits wait for another try.
     */
    async markCorrected(courseId: string): Promise<{ kind: 'published' } | { kind: 'checks_failed'; reasons: string[] } | { kind: 'nothing_to_publish' | 'no_checker' | 'not_found' }> {
      if (!UUID.test(courseId) || !(await pool.query(`SELECT 1 FROM courses WHERE id = $1`, [courseId])).rowCount) return { kind: 'not_found' };
      const building = (await pool.query(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'building'`, [courseId])).rows[0];
      if (!building) return { kind: 'nothing_to_publish' };
      if (!opts.checker) return { kind: 'no_checker' };
      const result = await opts.checker(building.id);
      if (!result.ok) {
        await log('course_correction_failed', result.reasons.join('; '), { course_id: courseId, version_id: building.id, reasons: result.reasons });
        return { kind: 'checks_failed', reasons: result.reasons };
      }
      const edited = (await pool.query(`SELECT chapter_id FROM chapter_texts WHERE version_id = $1`, [building.id])).rows.map((r) => r.chapter_id as string);
      await versions.publish(building.id, { correction: true });
      if (edited.length) {
        await pool.query(`UPDATE course_flags SET status = 'handled', action = 'edited', handled_at = $2 WHERE course_id = $1 AND status = 'open' AND target_type = 'chapter' AND target_id = ANY($3)`, [courseId, now(), edited]);
        for (const id of edited) await settleReview(id);
      }
      await log('course_correction_published', '', { course_id: courseId, version_id: building.id, chapters: edited });
      return { kind: 'published' };
    },

    /** Asks for a chapter to be written again (the pipeline picks the run up) and handles its open flags. */
    async regenerate(chapterId: string, why: string): Promise<boolean> {
      const ch = await chapterCourse(chapterId);
      if (!ch || ch.chapter_status === 'removed') return false;
      await pool.query(`INSERT INTO course_runs (course_id, kind, stage, percent, started_at) VALUES ($1, 'correction', $2, 0, $3)`, [ch.course_id, `regenerate:${chapterId}`, now()]);
      await pool.query(`UPDATE course_flags SET status = 'handled', action = 'regenerated', handled_at = $2 WHERE target_type = 'chapter' AND target_id = $1 AND status = 'open'`, [chapterId, now()]);
      await settleReview(chapterId);
      await log('course_regenerate', why, { course_id: ch.course_id, chapter_id: chapterId });
      return true;
    },

    /** Every claim about law, safety, money or health in a course, with the passage that supports it. */
    async excerpts(courseId: string) {
      if (!UUID.test(courseId)) return [];
      return (await pool.query(`SELECT chapter_id, category, claim, excerpt, url, created_at FROM claim_excerpts WHERE course_id = $1 ORDER BY created_at, id`, [courseId])).rows as Array<{ chapter_id: string; category: string; claim: string; excerpt: string; url: string; created_at: Date }>;
    },

    /** An owner action outside courses that is still logged here (editing the tracked list). */
    record: (action: string, reason: string, detail?: unknown) => log(action, reason, detail).then(() => undefined),
  };
}

export type CourseModeration = ReturnType<typeof createCourseModeration>;
