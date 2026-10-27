import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRateLimiter } from './rateLimit.ts';

const HOUR = 60 * 60_000;

function limiter(max = 60) {
  let t = 1_000_000;
  const l = createRateLimiter({ max, windowMs: HOUR, now: () => t });
  return { l, advance: (ms: number) => (t += ms) };
}

test('Scenario: Rate limit - 60 are allowed, the 61st is not', () => {
  const { l } = limiter();
  for (let i = 1; i <= 60; i++) assert.equal(l.take('device-a'), true, `request ${i}`);
  assert.equal(l.take('device-a'), false);
  assert.equal(l.take('device-a'), false); // and it stays refused, without counting against anything
});

test('each device has its own allowance', () => {
  const { l } = limiter(2);
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), false);
  assert.equal(l.take('b'), true); // b is unaffected by a
  assert.equal(l.take('b'), true);
  assert.equal(l.take('b'), false);
});

test('the window rolls: a request is forgotten exactly one hour after it was made', () => {
  const { l, advance } = limiter(2);
  assert.equal(l.take('a'), true); // at 0
  advance(30 * 60_000);
  assert.equal(l.take('a'), true); // at 30 minutes
  assert.equal(l.take('a'), false);
  advance(30 * 60_000 - 1); // 59 minutes 59.999 seconds after the first
  assert.equal(l.take('a'), false);
  advance(1); // exactly an hour after the first: it has aged out
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), false); // the one from minute 30 and the new one are still inside the window
  advance(30 * 60_000);
  assert.equal(l.take('a'), true);
});

test('refused requests do not extend the wait', () => {
  const { l, advance } = limiter(1);
  assert.equal(l.take('a'), true);
  for (let i = 0; i < 10; i++) {
    advance(5 * 60_000);
    assert.equal(l.take('a'), false); // hammering inside the hour
  }
  advance(10 * 60_000); // an hour and ten minutes after the only allowed request
  assert.equal(l.take('a'), true);
});

test('an allowance of 1 and of 0', () => {
  assert.equal(limiter(1).l.take('a'), true);
  const { l } = limiter(0);
  assert.equal(l.take('a'), false);
});

test('many one-off keys do not break the limiter, and old ones are forgotten', () => {
  const { l, advance } = limiter(1);
  for (let i = 0; i < 2500; i++) l.take(`key-${i}`); // triggers the clean-up sweep twice
  advance(HOUR + 1);
  for (let i = 0; i < 2500; i++) assert.equal(l.take(`key-${i}`), true, `key ${i} is allowed again`);
  assert.equal(l.take('key-0'), false); // and the limit still applies
});

test('the real clock is used when none is given', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const l = createRateLimiter({ max: 1, windowMs: HOUR });
  assert.equal(l.take('x'), true);
  assert.equal(l.take('x'), false);
  t.mock.timers.tick(HOUR - 1);
  assert.equal(l.take('x'), false);
  t.mock.timers.tick(1); // an hour on the clock Date.now reads
  assert.equal(l.take('x'), true);
});
