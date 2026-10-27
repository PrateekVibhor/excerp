import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOrder, highEarly, hybridOrder, kendallDistance, movesNeeded, pairViolations, shapeCourse, stabilityOf, stageOrder, topoOrder, wilson } from './order.ts';

const prio = (mentions: Record<string, number>) => (c: string) => mentions[c] ?? 0;

test('a prerequisite order puts what must come first first, and breaks ties by how critical a skill is', () => {
  const { order, droppedEdges } = topoOrder(['c', 'b', 'a', 'd'], [['a', 'b'], ['b', 'c']], prio({ a: 1, b: 1, c: 1, d: 9 }));
  assert.deepEqual(order, ['d', 'a', 'b', 'c'], 'd has no prerequisites and the highest priority, so it leads; the chain follows in order');
  assert.deepEqual(droppedEdges, []);
});

test('a cycle is broken, not looped on: the edge dropped is recorded and every concept still appears once', () => {
  const { order, droppedEdges } = topoOrder(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']], prio({ a: 3, b: 2, c: 1 }));
  assert.equal(order.length, 3);
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
  assert.equal(droppedEdges.length, 1);
});

test('edges that mention unknown concepts or themselves are ignored', () => {
  const { order } = topoOrder(['a', 'b'], [['a', 'a'], ['a', 'zzz'], ['zzz', 'b'], ['a', 'b']], prio({}));
  assert.deepEqual(order, ['a', 'b']);
});

test('stage order: earlier stages first, then more critical first, then by name', () => {
  const order = stageOrder({ x: 2, y: 1, z: 2, w: 1 }, prio({ x: 5, y: 1, z: 9, w: 1 }));
  assert.deepEqual(order, ['w', 'y', 'z', 'x'], 'stage 1: w and y tie, by name; stage 2: z before x');
});

test('the hybrid uses prerequisite edges only inside a stage', () => {
  const stages = { a: 1, b: 1, c: 2, d: 2 };
  // c must come before d (inside stage 2); d is also said to precede a, which crosses stages and is ignored.
  const order = hybridOrder(stages, [['c', 'd'], ['d', 'a']], prio({ a: 1, b: 2, c: 1, d: 9 }));
  assert.deepEqual(order, ['b', 'a', 'c', 'd']);
});

test('shapeCourse: chapters of two or three concepts, sections of four to six chapters, nothing lost or repeated', () => {
  for (const n of [8, 12, 20, 24, 26, 30, 36, 40]) {
    const order = Array.from({ length: n }, (_, i) => `k${i}`);
    const { sections, ok } = shapeCourse(order);
    const flat = sections.flat(2);
    assert.deepEqual(flat, order, `n=${n}: order kept`);
    for (const ch of sections.flat()) assert.ok(ch.length === 2 || ch.length === 3, `n=${n}: chapter size ${ch.length}`);
    if (ok) for (const s of sections) assert.ok(s.length >= 4 && s.length <= 6, `n=${n}: section of ${s.length} chapters`);
  }
  assert.equal(shapeCourse(Array.from({ length: 24 }, (_, i) => `k${i}`)).ok, true);
  assert.equal(shapeCourse(Array.from({ length: 20 }, (_, i) => `k${i}`)).ok, false, '7 chapters cannot be split into sections of 4 to 6');
});

test('kendallDistance: 0 for the same order, 1 for the reverse, and only common concepts count', () => {
  assert.equal(kendallDistance(['a', 'b', 'c'], ['a', 'b', 'c']), 0);
  assert.equal(kendallDistance(['a', 'b', 'c'], ['c', 'b', 'a']), 1);
  assert.equal(kendallDistance(['a', 'b', 'c'], ['b', 'a', 'c']), 1 / 3);
  assert.equal(kendallDistance(['a', 'b', 'x'], ['b', 'a', 'y']), 1, 'only a and b are common, and they are swapped');
});

test('movesNeeded: the fewest concepts to pick up and put elsewhere to reach the corrected order', () => {
  assert.equal(movesNeeded(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']), 0);
  assert.equal(movesNeeded(['b', 'a', 'c', 'd'], ['a', 'b', 'c', 'd']), 1);
  assert.equal(movesNeeded(['d', 'c', 'b', 'a'], ['a', 'b', 'c', 'd']), 3);
  assert.equal(movesNeeded(['a', 'c', 'd', 'b'], ['a', 'b', 'c', 'd']), 1);
});

test('pairViolations counts only decisive labels, and either-order pairs never violate', () => {
  const pairs = [
    { a: 'sql', b: 'dashboards', first: 'a' as const },
    { a: 'roadmaps', b: 'sql', first: 'either' as const },
    { a: 'metrics', b: 'sql', first: 'b' as const },
  ];
  assert.deepEqual(pairViolations(['sql', 'metrics', 'dashboards', 'roadmaps'], pairs), { violations: 0, decisive: 2, total: 3 });
  assert.deepEqual(pairViolations(['dashboards', 'metrics', 'sql', 'roadmaps'], pairs), { violations: 2, decisive: 2, total: 3 });
  assert.deepEqual(pairViolations(['sql'], pairs), { violations: 0, decisive: 0, total: 3 }, 'a pair with a concept missing from the order is not counted');
});

test('wilson: a 95% interval that is wide for a small sample and holds the observed rate', () => {
  const small = wilson(27, 30);
  assert.ok(small.low > 0.72 && small.low < 0.76, `lower bound ${small.low}`);
  assert.ok(small.high > 0.95 && small.high <= 1);
  const big = wilson(270, 300);
  assert.ok(big.high - big.low < small.high - small.low);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1, rate: 0 });
  assert.equal(wilson(0, 30).low, 0);
});

test('highEarly: the share of the most critical concepts that land in the first third', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(highEarly(order, new Set(['a', 'b'])), 1);
  assert.equal(highEarly(order, new Set(['a', 'f'])), 0.5);
  assert.equal(highEarly(order, new Set()), 0);
});

test('stability: runs that agree score 1, runs that disagree score lower', () => {
  assert.equal(stabilityOf([['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']]), 1);
  assert.equal(stabilityOf([['a', 'b', 'c'], ['c', 'b', 'a']]), 0);
  assert.ok(stabilityOf([['a', 'b', 'c', 'd'], ['a', 'b', 'd', 'c'], ['b', 'a', 'c', 'd']]) < 1);
  assert.equal(stabilityOf([['a', 'b']]), 1, 'one run is trivially stable');
});

test('the automatic order check fails a clearly wrong order and passes a right one', () => {
  const pairs = [
    { a: 'basics', b: 'advanced', first: 'a' as const },
    { a: 'tools', b: 'practice', first: 'a' as const },
    { a: 'practice', b: 'review', first: 'a' as const },
    { a: 'basics', b: 'review', first: 'a' as const },
    { a: 'tools', b: 'review', first: 'a' as const },
  ];
  const right = ['basics', 'tools', 'practice', 'advanced', 'review'];
  assert.equal(checkOrder(right, pairs).ok, true);
  const scrambled = [...right].reverse();
  const bad = checkOrder(scrambled, pairs);
  assert.equal(bad.ok, false);
  assert.ok(bad.rate > 0.5);
  assert.equal(checkOrder(right, []).ok, true, 'no pairs: nothing to contradict');
  assert.equal(checkOrder(right, pairs, 0).ok, true);
  assert.equal(checkOrder(['basics', 'practice', 'tools', 'advanced', 'review'], pairs, 0).ok, false, 'a strict limit of none');
});
