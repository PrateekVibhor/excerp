// Plan 16: the request log and the limits that count it (spec 16, section 5). Source searches count even when cancelled or expired;
// a repeat request for a role that already has a course does not. A refusal says which limit and when to try again.
import type pg from 'pg';
import type { CourseSettings, createCourseSettings } from './settings.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETENTION_DAYS = 90;

export type LimitCode = 'courses_off' | 'source_search_limit' | 'source_search_cap' | 'course_limit' | 'generation_cap' | 'refresh_limit' | 'refresh_cap' | 'credit_cap';

export type Decision =
  | { ok: true; requestId: number; /** an earlier request of the same reader the same day: nothing new started */ repeat?: boolean; /** the pool was checked in the last day: nothing to do */ alreadyChecked?: boolean }
  | { ok: false; code: LimitCode; retryAt: Date | null; requestId?: number };

/**
 * When a limit of `limit` per window frees up, given the times of the requests inside the window: null if it is not reached,
 * the moment enough old ones have aged out if it is, and undefined if the limit is zero (it never frees up).
 */
export function windowRetry(times: Date[], limit: number, windowMs: number): Date | null | undefined {
  if (limit <= 0) return undefined;
  if (times.length < limit) return null;
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  return new Date(sorted[sorted.length - limit]!.getTime() + windowMs);
}

type Blocked = { code: LimitCode; retryAt: Date | null };
const later = (a: Date | null | undefined, b: Date | null | undefined) => (a === undefined || b === undefined ? undefined : a === null ? b : b === null ? a : a > b ? a : b);

/** True when a request is let through the limits that business analyst lists are free of while the testing-phase toggle is off. */
const freeOf = (s: CourseSettings, independent: boolean) => independent && !s.limitsOnBaLists;
/** The SQL that keeps those lists' requests out of everyone else's counts (while the toggle is off), so they never use up a limit that applies to another course. */
const countable = (s: CourseSettings) => (s.limitsOnBaLists ? '' : ` AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = course_requests.course_id AND c.independent)`);

/** The search credits all course runs have recorded, counted from the cap's baseline. */
export async function creditsUsed(db: pg.Pool | pg.PoolClient, s: CourseSettings): Promise<number> {
  const total = Number((await db.query(`SELECT coalesce(sum(tavily_credits), 0)::bigint AS n FROM course_runs`)).rows[0].n);
  return Math.max(0, total - s.creditCap.baseline);
}
/** The credits left under the overall cap, or null when there is no cap (a total of 0). Never below zero. */
export async function creditsRemaining(db: pg.Pool | pg.PoolClient, s: CourseSettings): Promise<number | null> {
  return s.creditCap.total > 0 ? Math.max(0, s.creditCap.total - (await creditsUsed(db, s))) : null;
}
/** Is there an overall cap, and has it been reached? A cap of 0 is no cap. */
export async function creditCapReached(db: pg.Pool | pg.PoolClient, s: CourseSettings): Promise<boolean> {
  return s.creditCap.total > 0 && (await creditsUsed(db, s)) >= s.creditCap.total;
}

export function createCourseRequests(pool: pg.Pool, settings: ReturnType<typeof createCourseSettings>, now: () => Date = () => new Date()) {
  const COUNTED_SEARCH = `('started', 'cancelled', 'expired')`;

  async function times(db: pg.Pool | pg.PoolClient, sql: string, args: unknown[]): Promise<Date[]> {
    return (await db.query(sql, args)).rows.map((r) => r.created_at as Date);
  }

  /** Runs a check and a write under one lock for the reader, so two requests at once cannot both take the last place. */
  async function guarded<T>(accountId: string, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [accountId]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function log(db: pg.Pool | pg.PoolClient, accountId: string, roleId: string, courseId: string | null, kind: string, outcome: string): Promise<number> {
    const { rows } = await db.query(`INSERT INTO course_requests (account_id, role_id, course_id, kind, outcome, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [accountId, roleId, courseId, kind, outcome, now()]);
    return Number(rows[0].id);
  }

  /** Refuses with the code and time, and logs the refusal. */
  async function refuse(db: pg.PoolClient, accountId: string, roleId: string, courseId: string | null, kind: string, blocked: Blocked): Promise<Decision> {
    const requestId = await log(db, accountId, roleId, courseId, kind, 'refused');
    return { ok: false, code: blocked.code, retryAt: blocked.retryAt, requestId };
  }

  const since = (ms: number) => new Date(now().getTime() - ms);

  return {
    /** A reader asks for sources for a role: five a day each (cancelled and expired ones count), and a global daily cap. */
    sourceSearch: async (accountId: string, roleId: string, courseId: string | null = null, opts: { /** A business analyst list: the global daily count does not hold it (unless the toggle is on). */ independent?: boolean } = {}): Promise<Decision> => {
      const s = await settings.get();
      if (s.coursesOff) return { ok: false, code: 'courses_off', retryAt: null };
      const free = freeOf(s, opts.independent === true);
      const notFree = countable(s);
      return guarded(accountId, async (client) => {
        const own = await times(client, `SELECT created_at FROM course_requests WHERE account_id = $1 AND kind = 'source_search' AND outcome IN ${COUNTED_SEARCH} AND created_at > $2`, [accountId, since(DAY)]);
        const ownRetry = windowRetry(own, s.perReader.sourceSearchesPerDay, DAY);
        if (ownRetry !== null) return refuse(client, accountId, roleId, courseId, 'source_search', { code: 'source_search_limit', retryAt: ownRetry ?? null });
        if (!free) {
          const all = await times(client, `SELECT created_at FROM course_requests WHERE kind = 'source_search' AND outcome IN ${COUNTED_SEARCH} AND created_at > $1${notFree}`, [since(DAY)]);
          const capRetry = windowRetry(all, s.global.sourceSearchesPerDay, DAY);
          if (capRetry !== null) return refuse(client, accountId, roleId, courseId, 'source_search', { code: 'source_search_cap', retryAt: capRetry ?? null });
        }
        const used = await creditCapReached(client, s);
        if (used) return refuse(client, accountId, roleId, courseId, 'source_search', { code: 'credit_cap', retryAt: null });
        return { ok: true, requestId: await log(client, accountId, roleId, courseId, 'source_search', 'started') };
      });
    },

    /** The reader opened a role that already has a course: logged, never counted. */
    servedExisting: async (accountId: string, roleId: string, courseId: string | null = null): Promise<Decision> => {
      if ((await settings.get()).coursesOff) return { ok: false, code: 'courses_off', retryAt: null };
      return { ok: true, requestId: await log(pool, accountId, roleId, courseId, 'source_search', 'served_existing') };
    },

    /** A pending search is cancelled by the reader or expires after seven days; it still counts. */
    markSourceSearch: async (requestId: number, outcome: 'cancelled' | 'expired'): Promise<void> => {
      await pool.query(`UPDATE course_requests SET outcome = $2 WHERE id = $1 AND kind = 'source_search'`, [requestId, outcome]);
    },

    /** A reader approves sources: one new course a day and three a month, and a global daily cap on generations. */
    approval: async (accountId: string, roleId: string, courseId: string | null = null, opts: { /** A business analyst list: the approval limits do not hold it (unless the toggle is on). */ independent?: boolean } = {}): Promise<Decision> => {
      const s = await settings.get();
      if (s.coursesOff) return { ok: false, code: 'courses_off', retryAt: null };
      const free = freeOf(s, opts.independent === true);
      const notFree = countable(s);
      return guarded(accountId, async (client) => {
        if (!free) {
          const month = await times(client, `SELECT created_at FROM course_requests WHERE account_id = $1 AND kind = 'approval' AND outcome = 'approved' AND created_at > $2${notFree}`, [accountId, since(30 * DAY)]);
          const day = month.filter((t) => t.getTime() > since(DAY).getTime());
          const dayRetry = windowRetry(day, s.perReader.approvalsPerDay, DAY);
          const monthRetry = windowRetry(month, s.perReader.approvalsPerMonth, 30 * DAY);
          if (dayRetry !== null || monthRetry !== null) {
            const retryAt = dayRetry === null ? monthRetry : monthRetry === null ? dayRetry : later(dayRetry, monthRetry);
            return refuse(client, accountId, roleId, courseId, 'approval', { code: 'course_limit', retryAt: retryAt ?? null });
          }
          const all = await times(client, `SELECT created_at FROM course_requests WHERE kind = 'approval' AND outcome = 'approved' AND created_at > $1${notFree}`, [since(DAY)]);
          const capRetry = windowRetry(all, s.global.generationsPerDay, DAY);
          if (capRetry !== null) return refuse(client, accountId, roleId, courseId, 'approval', { code: 'generation_cap', retryAt: capRetry ?? null });
        }
        if (await creditCapReached(client, s)) return refuse(client, accountId, roleId, courseId, 'approval', { code: 'credit_cap', retryAt: null });
        return { ok: true, requestId: await log(client, accountId, roleId, courseId, 'approval', 'approved') };
      });
    },

    /** A reader asks for a list to be checked for new sources now: once an hour for the list, whoever asks. An answer of "nothing new" is never asked of this (it uses nothing up). */
    listRefresh: async (accountId: string, roleId: string, courseId: string): Promise<Decision> => {
      const s = await settings.get();
      if (s.coursesOff) return { ok: false, code: 'courses_off', retryAt: null };
      return guarded(courseId, async (client) => {
        const last = (await client.query(`SELECT created_at FROM course_requests WHERE course_id = $1 AND kind = 'refresh' AND outcome = 'started' AND created_at > $2 ORDER BY created_at DESC LIMIT 1`, [courseId, since(HOUR)])).rows[0]?.created_at as Date | undefined;
        if (last) return refuse(client, accountId, roleId, courseId, 'refresh', { code: 'refresh_limit', retryAt: new Date(last.getTime() + HOUR) });
        return { ok: true, requestId: await log(client, accountId, roleId, courseId, 'refresh', 'started') };
      });
    },

    /** A reader asks for an earlier refresh: once per course per reader per 14 days, the same request all day, and a global daily cap. */
    refresh: async (accountId: string, roleId: string, courseId: string): Promise<Decision> => {
      const s = await settings.get();
      if (s.coursesOff) return { ok: false, code: 'courses_off', retryAt: null };
      return guarded(accountId, async (client) => {
        const windowMs = s.perReader.refreshEveryDays * DAY;
        const mine = (await client.query(`SELECT id, created_at FROM course_requests WHERE account_id = $1 AND course_id = $2 AND kind = 'refresh' AND outcome = 'started' AND created_at > $3 ORDER BY created_at DESC`, [accountId, courseId, since(windowMs)])).rows;
        if (mine[0] && (mine[0].created_at as Date).getTime() > since(DAY).getTime()) return { ok: true, requestId: Number(mine[0].id), repeat: true };
        const retry = windowRetry(mine.map((r) => r.created_at as Date), 1, windowMs);
        if (retry !== null) return refuse(client, accountId, roleId, courseId, 'refresh', { code: 'refresh_limit', retryAt: retry ?? null });

        const checked = (await client.query(`SELECT last_checked_at FROM courses WHERE id = $1`, [courseId])).rows[0]?.last_checked_at as Date | null | undefined;
        if (checked && checked.getTime() > since(DAY).getTime()) return { ok: true, requestId: await log(client, accountId, roleId, courseId, 'refresh', 'served_existing'), alreadyChecked: true };

        const runs = await times(client, `SELECT started_at AS created_at FROM course_runs WHERE kind = 'refresh' AND started_at > $1`, [since(DAY)]);
        const capRetry = windowRetry(runs, s.global.refreshChecksPerDay, DAY);
        if (capRetry !== null) return refuse(client, accountId, roleId, courseId, 'refresh', { code: 'refresh_cap', retryAt: capRetry ?? null });
        return { ok: true, requestId: await log(client, accountId, roleId, courseId, 'refresh', 'started') };
      });
    },

    /** Deletes log rows older than 90 days; returns how many. */
    purge: async (): Promise<number> => (await pool.query(`DELETE FROM course_requests WHERE created_at < $1`, [since(RETENTION_DAYS * DAY)])).rowCount ?? 0,
  };
}
