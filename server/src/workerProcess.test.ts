// Starts worker.ts itself, the way the container does, and checks the timers it is configured for really start. The database is unreachable on purpose: a failed pass is logged and the
// next one scheduled, which is all this needs. (A circular import between worker.ts and the files it loads for the timers once left it silently stuck before they started.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function lines(extra: Record<string, string>, until: (events: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'src/worker.ts'], {
    env: { PATH: process.env.PATH ?? '', TAVILY_API_KEY: 'x', NEBIUS_API_KEY: 'x', NEBIUS_MODEL: 'x', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', RUN_ON_START: 'false', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop()!;
    for (const part of parts) try { events.push(JSON.parse(part)); } catch { /* not a log line */ }
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !until(events)) await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill('SIGKILL');
  return events;
}
const has = (events: Record<string, unknown>[], event: string, name: string) => events.some((e) => e.event === event && e.name === name);

test('worker.ts starts the course runner when COURSE_RUNNER_SECONDS is set, and schedules its next pass', async () => {
  const events = await lines({ COURSE_RUNNER_SECONDS: '15' }, (e) => has(e, 'run_scheduled', 'course_runner'));
  assert.ok(has(events, 'worker_started', 'course_runner'), 'course runner start line missing');
  assert.ok(has(events, 'run_scheduled', 'course_runner'), 'course runner timer not scheduled');
});

test('worker.ts starts the list refresh when LIST_REFRESH_MINUTES is set, and schedules its next pass', async () => {
  const events = await lines({ LIST_REFRESH_MINUTES: '60' }, (e) => has(e, 'run_scheduled', 'list_refresh'));
  assert.ok(has(events, 'worker_started', 'list_refresh'), 'list refresh start line missing');
  assert.ok(has(events, 'run_scheduled', 'list_refresh'), 'list refresh timer not scheduled');
});

test('worker.ts starts neither extra timer when neither is configured', async () => {
  const events = await lines({}, (e) => e.some((x) => x.event === 'run_scheduled' || x.event === 'last_run_unknown'));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(!events.some((e) => e.name === 'course_runner' || e.name === 'list_refresh'));
});
