// Plan 16: a reader joins a course the first time they do anything in it. Joining records when they were last active (a reader is active
// if that was within 45 days) and the version whose changelog they have already seen, so later updates are news to them.
import type pg from 'pg';

/** `pasted` is a job description the reader pasted when asking for the course: kept exactly as pasted, for the build to read, and never returned by any route. */
export async function enrolReader(db: pg.Pool | pg.PoolClient, accountId: string, courseId: string, typed: string, at: Date, pasted?: string): Promise<void> {
  const { rows } = await db.query(
    `INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at, pasted_text) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, course_id) DO UPDATE SET last_active_at = EXCLUDED.last_active_at RETURNING (xmax = 0) AS joined`,
    [accountId, courseId, typed, at, pasted || null],
  );
  if (rows[0].joined) {
    await db.query(
      `INSERT INTO course_seen (account_id, course_id, seen_version)
       VALUES ($1, $2, coalesce((SELECT v.version FROM courses c JOIN course_versions v ON v.id = c.published_version WHERE c.id = $2), 0)) ON CONFLICT DO NOTHING`,
      [accountId, courseId],
    );
  }
}
