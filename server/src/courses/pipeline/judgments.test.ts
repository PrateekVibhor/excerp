import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { role } from '../../../testkit/courseFixtures.ts';
import { createJudgments } from './judgments.ts';

const { db } = useCourseDb('judgments', { reset: ['roles'] });
const T0 = new Date('2026-10-20T12:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const concept = async (p: import('pg').Pool) => role(p, 'business analyst', 'x');

db('a judgment is remembered per role, concept name (any capitals), page, industry and judge, and found again later', async (p) => {
  const id = await concept(p);
  const j = createJudgments(p, () => T0);
  assert.equal(await j.get(id, 'Elicitation', 'https://www.Example.org/a/', 'banking', 'm1'), null);
  await j.put(id, 'Elicitation', 'https://www.Example.org/a/', 'banking', 'm1', { keep: true, kind: 'primary', why: 'official guide' });
  assert.deepEqual(await j.get(id, 'Elicitation', 'https://example.org/a', 'banking', 'm1'), { keep: true, kind: 'primary', why: 'official guide' }); // the same page, written another way
  assert.ok(await j.get(id, 'ELICITATION', 'https://example.org/a', 'banking', 'm1'), 'the concept name is matched without regard to capitals');
  assert.equal(await j.get(id, 'Elicitation', 'https://example.org/a', 'insurance', 'm1'), null);
  assert.equal(await j.get(id, 'Documentation', 'https://example.org/a', 'banking', 'm1'), null);
  assert.equal(await j.get(id, 'Elicitation', 'https://example.org/a', 'banking', 'm2'), null);
  await j.put(id, 'Elicitation', 'https://example.org/b', '', 'm1', { keep: false, kind: 'offtopic', why: 'not about it' });
  assert.deepEqual(await j.get(id, 'Elicitation', 'https://example.org/b', '', 'm1'), { keep: false, kind: 'offtopic', why: 'not about it' }); // a rejection is remembered too
});

db('a judgment older than thirty days is not used, and a newer one replaces it', async (p) => {
  const id = await concept(p);
  await createJudgments(p, () => T0).put(id, 'Elicitation', 'https://example.org/a', '', 'm1', { keep: true, kind: 'secondary', why: 'old' });
  assert.ok(await createJudgments(p, () => day(29)).get(id, 'Elicitation', 'https://example.org/a', '', 'm1'));
  assert.equal(await createJudgments(p, () => day(31)).get(id, 'Elicitation', 'https://example.org/a', '', 'm1'), null);
  await createJudgments(p, () => day(31)).put(id, 'Elicitation', 'https://example.org/a', '', 'm1', { keep: false, kind: 'offtopic', why: 'new' });
  assert.equal((await createJudgments(p, () => day(31)).get(id, 'Elicitation', 'https://example.org/a', '', 'm1'))?.why, 'new');
});
