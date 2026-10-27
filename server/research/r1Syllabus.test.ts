import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consistentPairs } from './r1Syllabus.ts';

test('a pair counts only when at least two syllabi contain both and all put them in the same order', () => {
  const pairs = consistentPairs([['sql', 'python', 'stats'], ['sql', 'stats'], ['python', 'sql']]);
  assert.deepEqual(pairs.map((p) => `${p.a}<${p.b}`).sort(), ['sql<stats']);
});

test('a pair seen in only one syllabus is left out', () => {
  assert.deepEqual(consistentPairs([['a', 'b'], ['c', 'd']]), []);
});

test('a concept repeated within one syllabus counts at its first position', () => {
  const pairs = consistentPairs([['a', 'b', 'a'], ['a', 'b']]);
  assert.deepEqual(pairs.map((p) => `${p.a}<${p.b}`), ['a<b']);
});
