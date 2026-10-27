// The scheduling loop the workers share. It lives in its own file, not in worker.ts, because worker.ts is the program that starts the timers: the files for the course runner and the list refresh import this, and importing worker.ts from them left the program waiting on itself.
import type { LogEvent } from './pipeline.ts';

export interface WorkerOptions {
  /** One pipeline run. May throw; the worker logs it and keeps its schedule. */
  run: () => Promise<unknown>;
  intervalMs: number;
  runOnStart: boolean;
  /**
   * When the last run that went through started (a time in ms), or undefined if there has been none. With it the worker catches up
   * at start when that run is older than the interval, and otherwise times the next run from it instead of from this boot, which
   * matters when the machine is switched off between work sessions. Left out, the first run waits one interval from the start.
   */
  lastRunAt?: () => Promise<number | undefined>;
  log: (event: LogEvent) => void;
  /** Said in every log event of this worker, so two workers in one process can be told apart. Left out, events are exactly as before. */
  name?: string;
  /** Shortest wait between runs, even if a run took longer than the interval. */
  minGapMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Worker {
  /** Cancels the next run. Resolves once any run in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Runs the pipeline on a fixed interval measured from the start of each run. The next
 * run is scheduled only after the current one finishes, so runs never overlap, and a
 * run that fails is logged without stopping the schedule.
 *
 * At start it asks `lastRunAt` when the pipeline last ran. If that is a whole interval ago or more, or never, it runs once
 * now to catch up. If it is more recent, the next run is due when the interval from that run is up.
 */
export function startWorker({
  run,
  intervalMs,
  runOnStart,
  lastRunAt,
  log: logEvent,
  name,
  minGapMs = 60_000,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: WorkerOptions): Worker {
  const log = (event: LogEvent) => logEvent(name ? { ...event, name } : event);
  let timer: unknown;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    log({ event: 'run_scheduled', inMinutes: Math.round(delayMs / 600) / 100, at: new Date(now() + delayMs).toISOString() });
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    const startedAt = now();
    inFlight = (async () => {
      try {
        await run();
      } catch (error) {
        log({ event: 'run_failed', reason: (error as Error).message });
      }
    })();
    await inFlight;
    inFlight = undefined;
    const elapsed = now() - startedAt;
    schedule(Math.max(minGapMs, intervalMs - elapsed));
  };

  const begin = async () => {
    if (runOnStart) return void tick();
    if (!lastRunAt) return schedule(intervalMs);
    let last: number | undefined;
    try {
      last = await lastRunAt();
    } catch (error) {
      if (stopped) return;
      log({ event: 'last_run_unknown', reason: (error as Error).message }); // no guess: wait a normal interval
      return schedule(intervalMs);
    }
    if (stopped) return;
    const age = last === undefined ? Infinity : now() - last;
    if (age >= intervalMs) {
      log({ event: 'catch_up', reason: last === undefined ? 'never_ran' : 'last_run_older_than_interval', ageMinutes: last === undefined ? null : Math.round(age / 60_000) });
      return void tick();
    }
    schedule(Math.min(intervalMs, intervalMs - age)); // a last run "in the future" (a wrong clock) never waits longer than one interval
  };

  log({ event: 'worker_started', intervalMinutes: intervalMs / 60_000, runOnStart });
  void begin();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
