// The course-only worker: it runs the course runner and nothing else. The ordinary worker also runs the article pipeline (and, if configured, the list refresh), which a real course
// build must not start by accident. It does nothing, and says why, unless COURSE_RUNNER_SECONDS is set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type pg from 'pg';
import { loadConfig } from './config.ts';
import { jsonLog, startCourseWorker, startupLine } from './courseWorker.ts';
import type { LogEvent } from './pipeline.ts';

const env = { TAVILY_API_KEY: 't', NEBIUS_API_KEY: 'n', NEBIUS_MODEL: 'm', DATABASE_URL: 'postgres://x/y' };
const pool = {} as pg.Pool;
const none = () => undefined;

test('without COURSE_RUNNER_SECONDS it refuses to start and says what to set', () => {
  assert.throws(() => startCourseWorker({ config: loadConfig(env), pool, log: none }), /COURSE_RUNNER_SECONDS is not set/);
});

test('with it, it runs the course runner at once and then every COURSE_RUNNER_SECONDS', async () => {
  const timers: number[] = [];
  const ran: number[] = [];
  const worker = startCourseWorker({ config: loadConfig({ ...env, COURSE_RUNNER_SECONDS: '15' }), pool, log: none, runner: async () => void ran.push(1), setTimer: (_f, ms) => (timers.push(ms), 1), clearTimer: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ran, [1]);
  assert.deepEqual(timers, [15_000]);
  await worker.stop();
});

test('it starts the course runner only: nothing of the article pipeline or the list refresh is in it', () => {
  const source = readFileSync(new URL('./courseWorker.ts', import.meta.url), 'utf8');
  for (const forbidden of ['runPipeline', 'realDeps', 'startListRefresh', 'listRefreshJob', "'./pipeline.ts'"]) assert.ok(!source.includes(forbidden), `${forbidden} must not be in the course worker`);
  assert.match(source, /startCourseRunner\(/);
});

test('it says where it works and what it may spend, so the terminal shows it before anything happens', () => {
  const line = startupLine('p4_run', loadConfig({ ...env, COURSE_RUNNER_SECONDS: '15', COURSE_FIND_CREDITS: '20', COURSE_BUILD_CREDITS: '40' }));
  assert.match(line, /schema p4_run/);
  assert.match(line, /every 15 seconds/);
  assert.match(line, /20 to find sources and 40 to build/);
});

test('its log is one line of JSON for each event, with the time', () => {
  const lines: string[] = [];
  const log = jsonLog((l) => lines.push(l), () => new Date('2026-10-20T15:00:00.000Z'));
  log({ event: 'course_runner', found: 1 } as LogEvent);
  assert.deepEqual(JSON.parse(lines[0]!), { at: '2026-10-20T15:00:00.000Z', event: 'course_runner', found: 1 });
});

test('the two entry points are in package.json: npm run demo:real and npm run course:worker', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;
  assert.match(scripts['demo:real']!, /e2e\/realRun\.ts$/);
  assert.match(scripts['course:worker']!, /src\/courseWorker\.ts$/);
  assert.match(scripts['course:worker']!, /--env-file=\.env/, 'the keys come from server/.env');
  assert.match(scripts['demo:real']!, /--env-file=\.env/);
});
