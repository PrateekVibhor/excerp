// The course runner (Plan 16, spec decision 11: generation is a background job that runs in the worker). The app queues a search for a course's sources when a
// reader asks for it, and a build when the reader approves; this picks those up, one at a time, and runs the finder and the builder, which already exist and are
// tested. It claims a run before it works on it, so no run is done twice; it ends a course failed, with a short reason, when its run cannot finish, so a reader is
// never left watching a build that is not happening; and when it starts it fails the runs an earlier stop left half done. Only one runner works on a database at a
// time (an advisory lock), which is also what makes it safe to clear those half-done runs. On a database without the Plan 16 tables it does nothing, and says so.
import type pg from 'pg';
import type { Config } from '../config.ts';
import { createNebiusChat, retryBusy, type Chat } from '../llm.ts';
import type { LogEvent } from '../pipeline.ts';
import { startWorker, type Worker } from '../startWorker.ts';
import type { Reader } from './coverage/coverage.ts';
import { loadLibraryFromDb } from './library/db.ts';
import { buildCourse, isStopReason, type BuildDeps } from './pipeline/build.ts';
import { createTavily, createYoutube } from './pipeline/clients.ts';
import { findCourseSources } from './pipeline/findSources.ts';
import { creditCapReached, creditsRemaining } from './requests.ts';
import { createCourseSettings } from './settings.ts';
import { fetchSourceText } from './library/text.ts';
import { createTimer } from './pipeline/timing.ts';
import { refreshListCourse } from './listRefresh.ts';
import { createVersionStore, VersionError } from './versions.ts';

type Outcome = { ok: true } | { ok: false; reason: string };
export interface RunnerDeps {
  pool: pg.Pool;
  /** Finds the postings for a course waiting for its sources, in the run the app queued for it. */
  find: (courseId: string, runId: number) => Promise<Outcome>;
  /** Builds an approved course, in the run that approval queued. */
  build: (courseId: string) => Promise<Outcome>;
  /** Checks a ready list against the reference library, in the run the reader's "refresh now" queued. Left out, the runner does not touch list checks. */
  refresh?: (courseId: string, runId: number) => Promise<Outcome>;
  now?: () => Date;
  log: (event: LogEvent) => void;
}
export type RunnerResult =
  | { status: 'ran'; found: number; built: number; refreshed: number; failed: number; skipped: number; recovered: number }
  | { status: 'skipped'; reason: 'plan_16_tables_missing' | 'another_run_in_progress' };

const LOCK = `hashtext('excerp:course_runner')`;
const NEEDED = ['courses', 'course_runs', 'course_versions', 'course_sources'];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** Fails the runs an earlier stop left started and never finished, and the courses waiting on them. Queued runs are left for the loop. */
async function recover(pool: pg.Pool, now: Date, withRefresh: boolean): Promise<number> {
  const versions = createVersionStore(pool, () => now);
  const stuck = (await pool.query(`SELECT id, course_id, kind, version_id FROM course_runs WHERE finished_at IS NULL AND stage <> 'queued' AND (kind IN ('source_finding', 'generation') OR (kind = 'refresh' AND $1 AND EXISTS (SELECT 1 FROM courses c WHERE c.id = course_runs.course_id AND c.mode = 'list'))) ORDER BY id`, [withRefresh])).rows;
  for (const r of stuck) {
    await pool.query(`UPDATE course_runs SET finished_at = $2, error = 'interrupted' WHERE id = $1`, [r.id, now]);
    if (r.kind === 'refresh') continue; // a list that could not be checked is still a good list
    if (r.kind === 'source_finding') await pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'interrupted' WHERE id = $1 AND status = 'finding_sources'`, [r.course_id]);
    else if (r.version_id) {
      try {
        await versions.fail(r.version_id, 'interrupted');
      } catch (error) {
        // A list cancelled or deleted while it was building has nothing left to fail (the cancel closed its version): the run is closed above and that is all.
        if (!(error instanceof VersionError)) throw error;
      }
    }
  }
  return stuck.length;
}

/** Takes the oldest queued run, atomically: the stage moves off 'queued' in the same statement, so a second runner could not take it too. */
async function claim(pool: pg.Pool, withRefresh: boolean) {
  // A list check is the runner's only for a list course, and only when it was given a way to do it; a narrative course's refresh stays where it was.
  return (await pool.query(
    `UPDATE course_runs SET stage = 'starting' WHERE id = (
       SELECT id FROM course_runs WHERE stage = 'queued' AND finished_at IS NULL
         AND (kind IN ('source_finding', 'generation') OR (kind = 'refresh' AND $1 AND EXISTS (SELECT 1 FROM courses c WHERE c.id = course_runs.course_id AND c.mode = 'list')))
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, course_id, kind, version_id`, [withRefresh],
  )).rows[0] as { id: number; course_id: string; kind: 'source_finding' | 'generation' | 'refresh'; version_id: string | null } | undefined;
}

export async function runCourseQueue(deps: RunnerDeps): Promise<RunnerResult> {
  const { pool, log } = deps;
  const now = deps.now ?? (() => new Date());
  const present = (await pool.query(`SELECT bool_and(to_regclass(t) IS NOT NULL) AS ok FROM unnest($1::text[]) AS t`, [NEEDED])).rows[0].ok as boolean;
  if (!present) {
    log({ event: 'course_runner_skipped', reason: 'plan_16_tables_missing' });
    return { status: 'skipped', reason: 'plan_16_tables_missing' };
  }
  const client = await pool.connect();
  try {
    if (!(await client.query(`SELECT pg_try_advisory_lock(${LOCK}) AS ok`)).rows[0].ok) {
      log({ event: 'course_runner_skipped', reason: 'another_run_in_progress' });
      return { status: 'skipped', reason: 'another_run_in_progress' };
    }
    try {
      const versions = createVersionStore(pool, now);
      const settings = createCourseSettings(pool);
      const withRefresh = deps.refresh !== undefined;
      const tally = { found: 0, built: 0, refreshed: 0, failed: 0, skipped: 0, recovered: await recover(pool, now(), withRefresh) };
      const close = (id: number, error: string | null) => pool.query(`UPDATE course_runs SET finished_at = $2, error = $3 WHERE id = $1 AND finished_at IS NULL`, [id, now(), error]);
      for (let run = await claim(pool, withRefresh); run; run = await claim(pool, withRefresh)) {
        const course = (await pool.query(`SELECT status, approved_at, mode FROM courses WHERE id = $1`, [run.course_id])).rows[0];
        const waiting = run.kind === 'source_finding' ? course?.status === 'finding_sources' : run.kind === 'refresh' ? course?.status === 'ready' && course.mode === 'list' : course?.status === 'building' && course.approved_at !== null;
        if (!waiting) {
          await close(run.id, 'course_not_waiting');
          tally.skipped++;
          continue;
        }
        // The overall cap on search credits: when it has been reached nothing more is run, and the reader is told why instead of waiting for work that will not happen.
        if (run.kind !== 'refresh' && (await creditCapReached(pool, await settings.get()))) {
          await close(run.id, 'credit_cap');
          tally.failed++;
          log({ event: 'course_run_failed', kind: run.kind, courseId: run.course_id, runId: run.id, reason: 'credit_cap' });
          if (run.kind === 'source_finding') await pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'credit_cap' WHERE id = $1 AND status = 'finding_sources'`, [run.course_id]);
          else if (run.version_id) await versions.fail(run.version_id, 'credit_cap');
          continue;
        }
        let outcome: Outcome;
        let threw = false;
        try {
          outcome = run.kind === 'source_finding' ? await deps.find(run.course_id, run.id) : run.kind === 'refresh' ? await deps.refresh!(run.course_id, run.id) : await deps.build(run.course_id);
        } catch (error) {
          outcome = { ok: false, reason: message(error) };
          threw = true;
        }
        await close(run.id, outcome.ok ? null : outcome.reason);
        if (!outcome.ok && isStopReason(outcome.reason)) {
          // The reader cancelled the list, or it was deleted, while this was running: the build stopped by itself. Not a failure, and nothing more to record.
          tally.skipped++;
          log({ event: 'course_build_stopped', reason: outcome.reason.includes('deleted') ? 'list_deleted' : 'cancelled' });
          continue;
        }
        if (outcome.ok) {
          if (run.kind === 'source_finding') tally.found++;
          else if (run.kind === 'refresh') tally.refreshed++;
          else tally.built++;
          continue;
        }
        tally.failed++;
        log({ event: 'course_run_failed', kind: run.kind, courseId: run.course_id, runId: run.id, reason: outcome.reason });
        // A returned failure of a build is the builder's to record (it fails the version). A search that failed, or anything that threw, is ended here. A list check that failed leaves the list as it was.
        if (run.kind === 'refresh') continue;
        if (run.kind === 'source_finding') await pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'find_failed' WHERE id = $1 AND status = 'finding_sources'`, [run.course_id]);
        else if (threw && run.version_id) await versions.fail(run.version_id, 'build_failed');
      }
      if (tally.found + tally.built + tally.refreshed + tally.failed + tally.skipped + tally.recovered > 0) log({ event: 'course_runner', ...tally });
      return { status: 'ran', ...tally };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    client.release();
  }
}

/** Adds the model tokens a run used to its row (the stages record the search credits themselves). */
export const recordUsage = (pool: pg.Pool, runId: number, tokens: { in: number; out: number }) =>
  pool.query(`UPDATE course_runs SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3 WHERE id = $1`, [runId, tokens.in, tokens.out]);

/** The finder and builder with the real model, search, page reading and library, each limited to its configured credits. Clients can be given for a test. */
export function realRunnerDeps(opts: {
  config: Config;
  pool: pg.Pool;
  youtubeKey?: string;
  now?: () => Date;
  /** Where the timing of each find and build is reported (`course_timing`). */
  log?: (event: { event: string; [key: string]: unknown }) => void;
  clients?: { chat?: (onUsage: (u: { prompt_tokens: number; completion_tokens: number }) => void) => Chat; judgeChat?: (onUsage: (u: { prompt_tokens: number; completion_tokens: number }) => void) => Chat; search?: BuildDeps['search']; extract?: BuildDeps['extract']; youtube?: BuildDeps['youtube']; reachable?: BuildDeps['reachable']; read?: Reader };
}): Pick<RunnerDeps, 'find' | 'build' | 'refresh'> {
  const { config, pool } = opts;
  const tavily = createTavily(config.tavilyApiKey);
  const search = opts.clients?.search ?? tavily;
  const extract = opts.clients?.extract ?? tavily;
  const youtube = opts.clients?.youtube ?? (opts.youtubeKey ? createYoutube(opts.youtubeKey) : { search: async () => [], videos: async () => [] });
  const reachable = opts.clients?.reachable ?? (async (url: string) => {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      return r.status < 400 || r.status === 405;
    } catch {
      return false;
    }
  });
  /** A run may use its configured budget, or what is left under the overall cap if that is less (no cap: its own budget). */
  const budget = async (own: number) => {
    const left = await creditsRemaining(pool, await createCourseSettings(pool).get());
    return left === null ? own : Math.min(own, left);
  };
  /** A model client that counts what it uses, for the run to record. */
  const counted = () => {
    const used = { in: 0, out: 0 };
    const onUsage = (u: { prompt_tokens: number; completion_tokens: number }) => void ((used.in += u.prompt_tokens), (used.out += u.completion_tokens));
    const chat = opts.clients?.chat ? opts.clients.chat(onUsage) : retryBusy(createNebiusChat({ apiKey: config.nebiusApiKey, model: config.nebiusModel, maxTokens: 32_000, timeoutMs: 240_000, onUsage }));
    // The page judge may be a smaller model (NEBIUS_JUDGE_MODEL); its tokens count toward the run like the main model's.
    const judge = opts.clients?.judgeChat ? opts.clients.judgeChat(onUsage) : config.nebiusJudgeModel ? retryBusy(createNebiusChat({ apiKey: config.nebiusApiKey, model: config.nebiusJudgeModel, maxTokens: 2000, timeoutMs: 120_000, onUsage })) : undefined;
    return { chat, judge, used };
  };
  return {
    async find(courseId, runId) {
      const m = counted();
      const t = createTimer();
      try {
        return await findCourseSources({ pool, chat: t.wrap('model', m.chat), search: t.wrapAll('search', search), onStageStart: t.stage, creditBudget: await budget(config.courseFindCredits), now: opts.now }, courseId, runId);
      } finally {
        t.end();
        opts.log?.({ event: 'course_timing', kind: 'source_finding', courseId, runId, ...t.report() });
        await recordUsage(pool, runId, m.used);
      }
    },
    /** The check of a ready list against the library: nothing new costs no model calls, and it uses no search credits either way. */
    async refresh(courseId, runId) {
      const m = counted();
      try {
        await refreshListCourse({ pool, chat: m.chat, read: opts.clients?.read ?? fetchSourceText, now: opts.now }, courseId);
        return { ok: true };
      } finally {
        await recordUsage(pool, runId, m.used);
      }
    },
    async build(courseId) {
      const m = counted();
      const t = createTimer();
      const runId = (await pool.query(`SELECT run_id FROM course_versions WHERE course_id = $1 AND status = 'building' ORDER BY version DESC LIMIT 1`, [courseId])).rows[0]?.run_id as number | undefined;
      try {
        return await buildCourse({ pool, chat: t.wrap('model', m.chat), ...(m.judge ? { judgeChat: t.wrap('judge', m.judge), judgeId: config.nebiusJudgeModel } : {}), search: t.wrapAll('search', search), extract: t.wrapAll('extract', extract), youtube: t.wrapAll('youtube', youtube), reachable: t.wrap('reachable', reachable), onStageStart: t.stage, library: { load: () => loadLibraryFromDb(pool), fetcher: t.wrap('fetch', fetch) }, creditBudget: await budget(config.courseBuildCredits), now: opts.now }, courseId);
      } finally {
        t.end();
        opts.log?.({ event: 'course_timing', kind: 'generation', courseId, runId, ...t.report() });
        if (runId !== undefined) await recordUsage(pool, runId, m.used);
      }
    },
  };
}

/** Starts the runner on its own timer inside the worker: at once, then every COURSE_RUNNER_SECONDS after a pass ends. Undefined (nothing started) unless it is configured. */
export function startCourseRunner(opts: RunnerDeps & {
  config: Config;
  /** Tests give their own run and timer. */
  runner?: (deps: RunnerDeps) => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Worker | undefined {
  const seconds = opts.config.courseRunnerSeconds;
  if (!seconds) return undefined;
  const { runner = runCourseQueue, setTimer, clearTimer, config, ...deps } = opts;
  void config;
  // minGapMs is the whole interval: a pass can take minutes, and the next one waits the full interval after it, never less.
  return startWorker({ run: () => runner(deps), intervalMs: seconds * 1000, minGapMs: seconds * 1000, runOnStart: true, log: deps.log, name: 'course_runner', ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
}
