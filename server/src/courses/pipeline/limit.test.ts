import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLimit } from './limit.ts';

const tick = () => new Promise((r) => setImmediate(r));

test('results come back in the order of the items, however the work finishes', async () => {
  const out = await mapLimit([30, 1, 10, 5], 4, async (n) => (await new Promise((r) => setTimeout(r, n)), n * 2));
  assert.deepEqual(out, [60, 2, 20, 10]);
});

test('no more than the limit run at once, and a limit of one is strictly one after another', async () => {
  for (const limit of [1, 3]) {
    let now = 0;
    let most = 0;
    await mapLimit([...Array(9).keys()], limit, async () => {
      most = Math.max(most, ++now);
      await tick();
      now--;
    });
    assert.equal(most, limit);
  }
});

test('after a failure nothing new starts, the work already running is waited for, and the first error is thrown', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  await assert.rejects(
    mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom 1');
      await new Promise((r) => setTimeout(r, 20));
      finished.push(n);
    }),
    /boom 1/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, [0]); // item 0 was running when item 1 failed, and had ended before the error came back
});

test('an empty list is fine', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
