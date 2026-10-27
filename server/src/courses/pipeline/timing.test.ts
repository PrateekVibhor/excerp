import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimer } from './timing.ts';

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

test('a wrapped function reports its calls, total and longest time, under the stage it ran in', async () => {
  const c = clock();
  const timer = createTimer(c.now);
  const chat = timer.wrap('model', async (n: number) => (c.advance(n), `done ${n}`));
  timer.stage('reference');
  assert.equal(await chat(100), 'done 100');
  await chat(300);
  timer.stage('list');
  await chat(50);
  timer.end();
  const r = timer.report();
  assert.deepEqual(r.calls.model, { calls: 3, totalMs: 450, maxMs: 300, maxParallel: 1 });
  assert.deepEqual(r.stages.map((s) => [s.stage, s.ms]), [['reference', 400], ['list', 50]]);
  assert.deepEqual(r.stages[0]!.calls.model, { calls: 2, totalMs: 400 });
});

test('calls that overlap are counted as parallel; one after another are not', async () => {
  const c = clock();
  const timer = createTimer(c.now);
  const releases: Array<() => void> = [];
  const slow = timer.wrap('search', () => new Promise<void>((resolve) => releases.push(resolve)));
  timer.stage('reference');
  const all = Promise.all([slow(), slow(), slow()]);
  c.advance(10);
  releases.forEach((r) => r());
  await all;
  assert.equal(timer.report().calls.search!.maxParallel, 3);
});

test('an object of functions is wrapped method by method, and a failure is still timed and still thrown', async () => {
  const c = clock();
  const timer = createTimer(c.now);
  const search = timer.wrapAll('search', { find: async () => (c.advance(5), 1), boom: async () => { c.advance(7); throw new Error('no'); } });
  timer.stage('s');
  await search.find();
  await assert.rejects(search.boom(), /no/);
  const r = timer.report();
  assert.deepEqual(r.calls['search.find'], { calls: 1, totalMs: 5, maxMs: 5, maxParallel: 1 });
  assert.deepEqual(r.calls['search.boom'], { calls: 1, totalMs: 7, maxMs: 7, maxParallel: 1 });
});
