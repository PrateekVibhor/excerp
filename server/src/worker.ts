import { loadConfig } from './config.ts';
import { createNebiusChat } from './llm.ts';
import { realDeps, runPipeline, type LogEvent } from './pipeline.ts';
import { createRunLog, type RunLog } from './runLog.ts';
import { startWorker, type Worker, type WorkerOptions } from './startWorker.ts';
export { startWorker, type Worker, type WorkerOptions };

/**
 * Wraps a pipeline run so that each one is written to the run record, as a success with the number of articles it stored or as a
 * failure with its reason (which is then thrown again for the worker to log). Failing to write the record is logged and never
 * breaks the run.
 */
export function recordedRun({ run, runLog, now = Date.now, log }: { run: () => Promise<unknown>; runLog: RunLog; now?: () => number; log: (event: LogEvent) => void }) {
  return async (): Promise<unknown> => {
    const startedAt = new Date(now());
    const write = async (record: Parameters<RunLog['record']>[0]) => {
      try {
        await runLog.record(record);
      } catch (error) {
        log({ event: 'run_not_recorded', reason: (error as Error).message });
      }
    };
    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      await write({ startedAt, finishedAt: new Date(now()), outcome: 'failed', error: (error as Error).message });
      throw error;
    }
    const stored = (result as { stored?: unknown } | undefined)?.stored;
    await write({ startedAt, finishedAt: new Date(now()), outcome: 'ok', ...(typeof stored === 'number' ? { stored } : {}) });
    return result;
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const { deps, db } = realDeps(config);
  const runLog = createRunLog(db.pool);
  const worker = startWorker({
    run: recordedRun({ run: () => runPipeline(deps), runLog, log: deps.log }),
    intervalMs: config.runIntervalMinutes * 60_000,
    runOnStart: config.runOnStart,
    lastRunAt: async () => (await runLog.lastSuccessAt())?.getTime(),
    log: deps.log,
  });
  // The list-course refresh runs on its own timer in this process, and only when LIST_REFRESH_MINUTES is set (it is imported here, not at the top, because it uses startWorker).
  const { startListRefresh } = await import('./courses/listRefreshJob.ts');
  const { fetchSourceText } = await import('./courses/library/text.ts');
  const listRefresh = startListRefresh({
    config, pool: db.pool, chat: createNebiusChat({ apiKey: config.nebiusApiKey, model: config.nebiusModel, maxTokens: 8000, timeoutMs: 180_000 }), read: fetchSourceText, log: deps.log,
  });
  // The course runner is a third timer in this process, and only when COURSE_RUNNER_SECONDS is set (also imported here, because it uses startWorker). It runs the
  // finder and builder with the real model, search and library, so the keys, the database and the credit budgets in the configuration are what it uses.
  const { realRunnerDeps, startCourseRunner } = await import('./courses/runner.ts');
  const courseRunner = config.courseRunnerSeconds ? startCourseRunner({ config, pool: db.pool, log: deps.log, ...realRunnerDeps({ config, pool: db.pool, youtubeKey: process.env.YOUTUBE_API_KEY?.trim(), log: deps.log }) }) : undefined;
  const shutdown = async (signal: string) => {
    deps.log({ event: 'worker_stopping', signal });
    // Docker waits about 10 seconds before killing; a run cut short is safe to resume next time.
    await Promise.race([Promise.all([worker.stop(), listRefresh?.stop(), courseRunner?.stop()]), new Promise((resolve) => setTimeout(resolve, 8000))]);
    await db.close();
    deps.log({ event: 'worker_stopped' });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
