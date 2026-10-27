import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, concept, publishedCourse, privateCourse, withdrawnCourse } from '../../../testkit/courseFixtures.ts';
import type { Chat } from '../../llm.ts';
import { classifyDelta, loadReusePool } from './delta.ts';

const { db } = useCourseDb('delta');
const reply = (o: object): Chat => async () => JSON.stringify(o);

db('only published, shared, not withdrawn courses of other roles are reuse sources', async (p) => {
  const mine = await publishedCourse(p); // the role being built has a course too: it is not a source for itself
  const other = await publishedCourse(p);
  await privateCourse(p, { ownerId: await account(p) });
  await withdrawnCourse(p);
  await p.query(`INSERT INTO roles (name, description) VALUES ('unpublished role', 'x')`);
  const pool = await loadReusePool(p, mine.roleId);
  const roleIds = [...new Set(pool.roles.map((r) => r.roleId))];
  assert.ok(roleIds.includes(other.roleId));
  assert.ok(!roleIds.includes(mine.roleId));
  assert.equal(pool.roles.length, roleIds.length);
  // private, withdrawn and unpublished courses contribute nothing
  const privRoles = (await p.query(`SELECT role_id FROM courses WHERE visibility = 'private' OR status <> 'ready'`)).rows.map((r) => r.role_id);
  assert.ok(privRoles.every((r) => !roleIds.includes(r)));
});

db('the pool carries every concept the similar courses teach, with its course', async (p) => {
  const mine = await publishedCourse(p);
  const other = await publishedCourse(p);
  const pool = await loadReusePool(p, mine.roleId);
  assert.equal(pool.concepts.filter((c) => c.roleId === other.roleId).length, other.conceptIds.length);
  assert.ok(pool.concepts.every((c) => c.courseId && c.name));
});

const poolOf = (...names: string[]) => names.map((name, i) => ({ id: `c${i}`, roleId: 'r0', courseId: 'k0', name }));
const mine = [{ name: 'python' }, { name: 'data pipelines' }, { name: 'rust' }, { name: 'monitoring' }];

test('each concept is classed covered, related or new, comparing against the concepts of all published courses together, with no role chosen first', async () => {
  const chat = reply({ results: [{ name: 'python', class: 'covered', match: 'c0' }, { name: 'data pipelines', class: 'related', match: 'c1' }, { name: 'rust', class: 'new' }, { name: 'monitoring', class: 'covered', match: 'c2' }] });
  const r = await classifyDelta(chat, mine, poolOf('python', 'etl', 'observability'));
  assert.deepEqual(r.map((x) => [x.name, x.class, x.match ?? null]), [['python', 'covered', 'c0'], ['data pipelines', 'related', 'c1'], ['rust', 'new', null], ['monitoring', 'covered', 'c2']]);
});

test('uncertain counts as related, never covered: a missing, malformed or unsupported answer is related, and a covered claim without a real match is related', async () => {
  const chat = reply({ results: [{ name: 'python', class: 'covered' }, { name: 'data pipelines', class: 'maybe', match: 'c1' }, { name: 'rust', class: 'covered', match: 'nonexistent' }] });
  const r = await classifyDelta(chat, mine, poolOf('python', 'etl'));
  assert.deepEqual(r.map((x) => [x.name, x.class]), [['python', 'related'], ['data pipelines', 'related'], ['rust', 'related'], ['monitoring', 'related']]);
});

test('with nothing to compare against everything is new, and the model is not called; a failed call makes everything related', async () => {
  let called = 0;
  const r = await classifyDelta(async () => (called++, '{}'), mine, []);
  assert.deepEqual(r.map((x) => x.class), ['new', 'new', 'new', 'new']);
  assert.equal(called, 0);
  const failed = await classifyDelta(async () => { throw new Error('down'); }, mine, poolOf('python'));
  assert.deepEqual(failed.map((x) => x.class), ['related', 'related', 'related', 'related']);
});

test('a failed call, an unusable answer and missing answers are logged; a genuine "all new" answer is not', async () => {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const failures: boolean[] = [];
  await classifyDelta(async () => { throw new Error('down'); }, mine, poolOf('python'), (m, failed) => (log(m), failures.push(Boolean(failed))));
  assert.deepEqual(failures, [true], 'a failed call is marked as a failure');
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /comparison failed.*down/i);
  logs.length = 0;
  await classifyDelta(reply({ results: 'none' }), mine, poolOf('python'), (m, failed) => (log(m), failures.push(Boolean(failed))));
  assert.match(logs[0]!, /not a list/i);
  assert.equal(failures.at(-1), true);
  logs.length = 0;
  failures.length = 0;
  await classifyDelta(reply({ results: [{ name: 'python', class: 'covered', match: 'c0' }] }), mine, poolOf('python'), (m, failed) => (log(m), failures.push(Boolean(failed))));
  assert.match(logs[0]!, /3 .*no usable answer/i);
  assert.deepEqual(failures, [false], 'some unanswered concepts are not a total failure');
  logs.length = 0;
  const allNew = await classifyDelta(reply({ results: mine.map((m) => ({ name: m.name, class: 'new' })) }), mine, poolOf('python'), log);
  assert.deepEqual(allNew.map((x) => x.class), ['new', 'new', 'new', 'new']);
  assert.deepEqual(logs, [], 'a real answer of nothing similar needs no log');
});
