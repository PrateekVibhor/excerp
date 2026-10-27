// The scheduled list-course refresh. The worker already runs the article pipeline on a timer; the refresh is a second timer in the same process (the model and
// page-reading credentials are already there), off unless LIST_REFRESH_MINUTES is set. A run costs a few queries when the library has not changed. It never
// overlaps another run, here or in another process (an advisory lock), and on a database without the Plan 16 tables it does nothing and says so.
import type pg from 'pg';
import type { Chat } from '../llm.ts';
import type { Config } from '../config.ts';
import type { LogEvent } from '../pipeline.ts';
import { startWorker, type Worker } from '../startWorker.ts';
import type { Reader } from './coverage/coverage.ts';
import { refreshListCourses } from './listRefresh.ts';

export interface RefreshJobDeps { pool: pg.Pool; chat: Chat; read: Reader; now?: () => Date; log: (event: LogEvent) => void }
export type RefreshJobResult = { status: 'ran'; courses: number; notified: number; errors: number } | { status: 'skipped'; reason: 'plan_16_tables_missing' | 'another_run_in_progress' };

const LOCK = `hashtext('excerp:list_refresh')`;
const NEEDED = ['courses', 'list_concepts', 'library_changes', 'course_changes'];

export async function runListRefresh(deps: RefreshJobDeps): Promise<RefreshJobResult> {
  const { pool, log } = deps;
  const present = (await pool.query(`SELECT bool_and(to_regclass(t) IS NOT NULL) AS ok FROM unnest($1::text[]) AS t`, [NEEDED])).rows[0].ok as boolean;
  if (!present) {
    log({ event: 'list_refresh_skipped', reason: 'plan_16_tables_missing' });
    return { status: 'skipped', reason: 'plan_16_tables_missing' };
  }
  const client = await pool.connect();
  try {
    if (!(await client.query(`SELECT pg_try_advisory_lock(${LOCK}) AS ok`)).rows[0].ok) {
      log({ event: 'list_refresh_skipped', reason: 'another_run_in_progress' });
      return { status: 'skipped', reason: 'another_run_in_progress' };
    }
    try {
      const r = await refreshListCourses({ pool, chat: deps.chat, read: deps.read, now: deps.now });
      log({ event: 'list_refresh', ...r });
      return { status: 'ran', ...r };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    client.release();
  }
}

/** Starts the refresh on its own timer inside the worker: at once, then every LIST_REFRESH_MINUTES. Undefined (nothing started) unless it is configured. */
export function startListRefresh(opts: RefreshJobDeps & {
  config: Config;
  /** Tests give their own run and timer. */
  runner?: (deps: RefreshJobDeps) => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Worker | undefined {
  const minutes = opts.config.listRefreshMinutes;
  if (!minutes) return undefined;
  const { runner = runListRefresh, setTimer, clearTimer, config, ...deps } = opts;
  void config;
  return startWorker({ run: () => runner(deps), intervalMs: minutes * 60_000, runOnStart: true, log: deps.log, name: 'list_refresh', ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
}
