// A worker that runs the course runner and nothing else: the finder and builder for the courses readers ask for. The ordinary worker (worker.ts) also runs the article pipeline, which
// would start by itself on a database where it has never run and spend search and model credits; this one never does. It does nothing, and says why, unless COURSE_RUNNER_SECONDS is
// set. Run only one worker against a database. Start it with `npm run course:worker`.
import type pg from 'pg';
import { loadConfig, type Config } from './config.ts';
import { realRunnerDeps, startCourseRunner } from './courses/runner.ts';
import { createDb } from './db.ts';
import type { Worker } from './startWorker.ts';

type Log = Parameters<typeof startCourseRunner>[0]['log'];

/** One line of JSON for each event, with the time. */
export const jsonLog = (write: (line: string) => void = console.log, now: () => Date = () => new Date()): Log => (event) => write(JSON.stringify({ at: now().toISOString(), ...event }));

export const startupLine = (schema: string, config: Config) =>
  `Course worker started in schema ${schema}: looking for queued courses every ${config.courseRunnerSeconds} seconds. Search credits for one course: up to ${config.courseFindCredits} to find sources and ${config.courseBuildCredits} to build. The article pipeline and the list refresh are not run.`;

export function startCourseWorker(opts: {
  config: Config;
  pool: pg.Pool;
  log: Log;
  youtubeKey?: string;
  /** Tests give their own run and timer. */
  runner?: Parameters<typeof startCourseRunner>[0]['runner'];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Worker {
  const { config, pool, log, youtubeKey, runner, setTimer, clearTimer } = opts;
  if (!config.courseRunnerSeconds) throw new Error('COURSE_RUNNER_SECONDS is not set: the course worker has nothing to do. Set it (15 is a sensible start) to turn the course runner on.');
  const worker = startCourseRunner({ config, pool, log, ...realRunnerDeps({ config, pool, youtubeKey, log }), ...(runner ? { runner } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
  if (!worker) throw new Error('the course runner did not start');
  return worker;
}

if (import.meta.main) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const schema = (await db.pool.query('SELECT current_schema() AS schema')).rows[0].schema as string;
  const log = jsonLog();
  let worker: Worker;
  try {
    worker = startCourseWorker({ config, pool: db.pool, log, youtubeKey: process.env.YOUTUBE_API_KEY?.trim() });
  } catch (error) {
    console.error((error as Error).message);
    await db.close();
    process.exit(1);
  }
  console.log(startupLine(schema, config));
  const shutdown = async (signal: string) => {
    log({ event: 'course_worker_stopping', signal });
    // A pass cut short is safe: a run that was started and not finished is closed as interrupted when the runner next starts.
    await Promise.race([worker.stop(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
