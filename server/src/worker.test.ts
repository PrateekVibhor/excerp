import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedRun, startWorker } from './worker.ts';
import { loadConfig } from './config.ts';
import type { LogEvent } from './pipeline.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Runs on its own and survives a failed run', async () => {
  const logs: LogEvent[] = [];
  let runs = 0;
  const worker = startWorker({
    run: async () => {
      runs += 1;
      if (runs === 1) throw new Error('database unreachable');
    },
    intervalMs: 20,
    minGapMs: 0,
    runOnStart: true,
    log: (e) => logs.push(e),
  });
  await wait(150);
  await worker.stop();
  assert.ok(runs >= 3, `expected at least 3 runs, got ${runs}`);
  const failed = logs.filter((e) => e.event === 'run_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, 'database unreachable');
});

test('Runs never overlap, even when a run outlasts the interval', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const worker = startWorker({
    run: async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(40);
      active -= 1;
    },
    intervalMs: 5,
    minGapMs: 5,
    runOnStart: true,
    log: () => {},
  });
  await wait(200);
  await worker.stop();
  assert.ok(runs >= 2);
  assert.equal(maxActive, 1);
});

test('Without run on start, the first run waits one interval', async () => {
  let runs = 0;
  const worker = startWorker({ run: async () => { runs += 1; }, intervalMs: 80, minGapMs: 0, runOnStart: false, log: () => {} });
  await wait(30);
  assert.equal(runs, 0);
  await wait(80);
  assert.equal(runs, 1);
  await worker.stop();
});

test('The next run is timed from the start of the previous one, with a minimum gap', () => {
  const delays: number[] = [];
  let clock = 0;
  let pending: (() => void) | undefined;
  startWorker({
    run: async () => { clock += 30; },
    intervalMs: 100,
    minGapMs: 10,
    runOnStart: false,
    log: () => {},
    now: () => clock,
    setTimer: (fn, ms) => { delays.push(ms); pending = fn; return 1; },
    clearTimer: () => {},
  });
  assert.deepEqual(delays, [100]);
  pending!();
  return wait(0).then(() => {
    assert.deepEqual(delays, [100, 70]);
  });
});

test('Stop cancels future runs and waits for the run in progress', async () => {
  let runs = 0;
  let finished = false;
  const worker = startWorker({
    run: async () => { runs += 1; await wait(40); finished = true; },
    intervalMs: 10,
    minGapMs: 0,
    runOnStart: true,
    log: () => {},
  });
  await wait(5);
  await worker.stop();
  assert.equal(finished, true);
  await wait(60);
  assert.equal(runs, 1);
});

test('RUN_ON_START defaults to true and rejects nonsense', () => {
  const base = { TAVILY_API_KEY: 't', NEBIUS_API_KEY: 'n', NEBIUS_MODEL: 'm', DATABASE_URL: 'postgres://x' };
  assert.equal(loadConfig(base).runOnStart, true);
  assert.equal(loadConfig({ ...base, RUN_ON_START: 'false' }).runOnStart, false);
  assert.throws(() => loadConfig({ ...base, RUN_ON_START: 'maybe' }), /RUN_ON_START must be true or false/);
});

test('A run longer than the interval still leaves the minimum gap', async () => {
  const delays: number[] = [];
  let clock = 0;
  startWorker({
    run: async () => { clock += 500; },
    intervalMs: 100,
    minGapMs: 10,
    runOnStart: true,
    log: () => {},
    now: () => clock,
    setTimer: (_fn, ms) => { delays.push(ms); return 1; },
    clearTimer: () => {},
  });
  await wait(0);
  assert.deepEqual(delays, [10]);
});

test('Stop while waiting means the scheduled run never happens', async () => {
  let runs = 0;
  const worker = startWorker({ run: async () => { runs += 1; }, intervalMs: 30, minGapMs: 0, runOnStart: false, log: () => {} });
  await worker.stop();
  await wait(60);
  assert.equal(runs, 0);
});

test('Stop clears the pending timer', async () => {
  const cleared: unknown[] = [];
  const worker = startWorker({
    run: async () => {},
    intervalMs: 100,
    runOnStart: false,
    log: () => {},
    setTimer: () => 'timer-1',
    clearTimer: (handle) => cleared.push(handle),
  });
  await worker.stop();
  assert.deepEqual(cleared, ['timer-1']);
});

// ---- catching up after the VM was off (the VM is stopped between work sessions to save cost) -----------------

const MIN = 60_000;
const DAY = 1440 * MIN;
const NOW = Date.parse('2026-10-09T20:00:00.000Z');

/** A worker whose clock and timer are ours: nothing waits for real, and the delay it asks for is recorded. */
function steppedWorker(opts: { lastRunAt?: () => Promise<number | undefined>; runOnStart?: boolean; run?: () => Promise<unknown>; intervalMs?: number }) {
  const logs: LogEvent[] = [];
  const delays: number[] = [];
  let runs = 0;
  const worker = startWorker({
    run: opts.run ?? (async () => { runs += 1; }),
    intervalMs: opts.intervalMs ?? DAY,
    runOnStart: opts.runOnStart ?? false,
    lastRunAt: opts.lastRunAt,
    log: (e) => logs.push(e),
    now: () => NOW,
    setTimer: (_fn, ms) => { delays.push(ms); return delays.length; },
    clearTimer: () => {},
  });
  return { worker, logs, delays, runs: () => runs };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Catch-up: when the last run is older than the interval, it runs once at start', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW - 4 * DAY });
  await settle();
  assert.equal(t.runs(), 1);
  const caught = t.logs.find((e) => e.event === 'catch_up');
  assert.ok(caught, 'the catch-up is logged');
  assert.equal(caught.reason, 'last_run_older_than_interval');
  assert.equal(caught.ageMinutes, 4 * 1440);
  await t.worker.stop();
});

test('Catch-up: after the catch-up run, the next run is one interval away, not another catch-up', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW - 4 * DAY });
  await settle();
  assert.equal(t.runs(), 1);
  assert.deepEqual(t.delays, [DAY]); // the run took no time on this clock, so a full interval remains
  await t.worker.stop();
});

test('Catch-up: a run exactly one interval old is due', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW - DAY });
  await settle();
  assert.equal(t.runs(), 1);
  await t.worker.stop();
});

test('Catch-up: when the pipeline has never run, it runs at start', async () => {
  const t = steppedWorker({ lastRunAt: async () => undefined });
  await settle();
  assert.equal(t.runs(), 1);
  assert.equal(t.logs.find((e) => e.event === 'catch_up')?.reason, 'never_ran');
  await t.worker.stop();
});

test('Catch-up: when the last run is recent, nothing runs now and the next run is due when the interval from that run is up', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW - 6 * 60 * MIN }); // 6 hours ago
  await settle();
  assert.equal(t.runs(), 0);
  assert.deepEqual(t.delays, [DAY - 6 * 60 * MIN]); // 18 hours, not a fresh 24 from the boot
  assert.equal(t.logs.some((e) => e.event === 'catch_up'), false);
  await t.worker.stop();
});

test('Catch-up: a last-run time in the future (a wrong clock) never waits longer than one interval', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW + 3 * DAY });
  await settle();
  assert.equal(t.runs(), 0);
  assert.deepEqual(t.delays, [DAY]);
  await t.worker.stop();
});

test('Catch-up: when the last run cannot be looked up, it says so and waits one interval instead of guessing', async () => {
  const t = steppedWorker({ lastRunAt: async () => { throw new Error('database unreachable'); } });
  await settle();
  assert.equal(t.runs(), 0);
  assert.deepEqual(t.delays, [DAY]);
  const unknown = t.logs.find((e) => e.event === 'last_run_unknown');
  assert.equal(unknown?.reason, 'database unreachable');
  await t.worker.stop();
});

test('Catch-up: with RUN_ON_START on, it still runs once at start, not twice', async () => {
  const t = steppedWorker({ runOnStart: true, lastRunAt: async () => NOW - 4 * DAY });
  await settle();
  assert.equal(t.runs(), 1);
  await t.worker.stop();
});

test('Catch-up: a catch-up run that fails is logged, and the schedule carries on', async () => {
  const t = steppedWorker({ lastRunAt: async () => NOW - 4 * DAY, run: async () => { throw new Error('search service down'); } });
  await settle();
  assert.equal(t.logs.find((e) => e.event === 'run_failed')?.reason, 'search service down');
  assert.deepEqual(t.delays, [DAY]);
  await t.worker.stop();
});

test('Catch-up: stopping while the last run is still being looked up means nothing runs and nothing is scheduled', async () => {
  let release!: (v: number) => void;
  const t = steppedWorker({ lastRunAt: () => new Promise<number>((resolve) => { release = resolve; }) });
  const stopping = t.worker.stop();
  release(NOW - 4 * DAY);
  await stopping;
  await settle();
  assert.equal(t.runs(), 0);
  assert.deepEqual(t.delays, []);
});

test('Without a way to look up the last run, the worker behaves as before: the first run waits one interval', async () => {
  const t = steppedWorker({});
  assert.equal(t.runs(), 0);
  assert.deepEqual(t.delays, [DAY]); // scheduled at once, without waiting for anything
  await t.worker.stop();
});

// ---- recording each run ------------------------------------------------------------------------------------------

test('recordedRun writes a successful run with its start, finish and number of stored articles', async () => {
  const written: unknown[] = [];
  let tick = 0;
  const run = recordedRun({
    run: async () => ({ stored: 7 }),
    runLog: { lastSuccessAt: async () => undefined, record: async (r) => { written.push(r); } },
    now: () => NOW + 1000 * tick++,
    log: () => {},
  });
  await run();
  assert.deepEqual(written, [{ startedAt: new Date(NOW), finishedAt: new Date(NOW + 1000), outcome: 'ok', stored: 7 }]);
});

test('recordedRun writes a failed run and passes the error on', async () => {
  const written: Array<Record<string, unknown>> = [];
  const run = recordedRun({
    run: async () => { throw new Error('model unreachable'); },
    runLog: { lastSuccessAt: async () => undefined, record: async (r) => { written.push(r as unknown as Record<string, unknown>); } },
    now: () => NOW,
    log: () => {},
  });
  await assert.rejects(run(), /model unreachable/);
  assert.equal(written[0].outcome, 'failed');
  assert.equal(written[0].error, 'model unreachable');
});

test('recordedRun: a record that cannot be written is logged and never breaks the run', async () => {
  const logs: LogEvent[] = [];
  const run = recordedRun({
    run: async () => ({ stored: 1 }),
    runLog: { lastSuccessAt: async () => undefined, record: async () => { throw new Error('disk full'); } },
    now: () => NOW,
    log: (e) => logs.push(e),
  });
  await run(); // does not throw
  assert.equal(logs.find((e) => e.event === 'run_not_recorded')?.reason, 'disk full');
});

test('recordedRun: a run that returns something without a stored count is still recorded as ok', async () => {
  const written: Array<Record<string, unknown>> = [];
  const run = recordedRun({
    run: async () => undefined,
    runLog: { lastSuccessAt: async () => undefined, record: async (r) => { written.push(r as unknown as Record<string, unknown>); } },
    now: () => NOW,
    log: () => {},
  });
  await run();
  assert.equal(written[0].outcome, 'ok');
  assert.equal('stored' in written[0] && written[0].stored !== undefined, false);
});

test('A worker given a name says so in its log events; one without a name logs exactly as before', async () => {
  const named: LogEvent[] = [];
  const plain: LogEvent[] = [];
  const a = startWorker({ run: async () => {}, intervalMs: 1000, minGapMs: 0, runOnStart: true, log: (e) => named.push(e), name: 'list_refresh', setTimer: () => 0, clearTimer: () => {} });
  const b = startWorker({ run: async () => {}, intervalMs: 1000, minGapMs: 0, runOnStart: true, log: (e) => plain.push(e), setTimer: () => 0, clearTimer: () => {} });
  await wait(20);
  await a.stop();
  await b.stop();
  assert.ok(named.length > 0 && named.every((e) => e.name === 'list_refresh'));
  assert.ok(plain.length > 0 && plain.every((e) => !('name' in e)));
});

test('the worker process starts the course runner only when it is configured, and stops it with the rest on shutdown', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8').split('if (import.meta.main)')[1]!;
  assert.match(main, /config\.courseRunnerSeconds \? startCourseRunner\(/);
  assert.match(main, /realRunnerDeps\(/);
  assert.match(main, /courseRunner\?\.stop\(\)/);
});
