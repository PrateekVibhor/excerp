// Plan 16: keeping course data tidy (spec 16, section 4). A handled flag is kept 90 days after it was handled, the request log 90 days, and an
// unapproved request closes after seven days. A course itself never expires. Safe to run as often as you like.
import type pg from 'pg';
import { createCourseRequests } from './requests.ts';
import type { createCourseSettings } from './settings.ts';
import { createCourseStarts } from './starts.ts';

export const HANDLED_FLAG_DAYS = 90;
const DAY_MS = 86_400_000;

export interface CourseCleanup {
  /** Requests nobody approved within seven days, now closed. */
  expiredAttempts: number;
  /** Flags handled 90 or more days ago, deleted. */
  deletedFlags: number;
  /** Request-log rows older than 90 days, deleted. */
  deletedRequests: number;
}

export async function runCourseCleanup(pool: pg.Pool, settings: ReturnType<typeof createCourseSettings>, now: Date): Promise<CourseCleanup> {
  const expiredAttempts = await createCourseStarts(pool, settings, () => now).expireStale();
  const flags = await pool.query(`DELETE FROM course_flags WHERE status = 'handled' AND handled_at IS NOT NULL AND handled_at <= $1`, [new Date(now.getTime() - HANDLED_FLAG_DAYS * DAY_MS)]);
  const deletedRequests = await createCourseRequests(pool, settings, () => now).purge();
  return { expiredAttempts, deletedFlags: flags.rowCount ?? 0, deletedRequests };
}
