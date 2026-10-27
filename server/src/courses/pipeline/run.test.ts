import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role } from '../../../testkit/courseFixtures.ts';
import { runStages, type Stage } from './run.ts';

const { db } = useCourseDb('prun');
const T0 = new Date('2026-10-12T12:00:00.000Z');
const clock = () => { let t = T0.getTime(); return () => new Date((t += 1000)); };
const runRow = async (p: import('pg').Pool, id: number) => (await p.query(`SELECT * FROM course_runs WHERE id = $1`, [id])).rows[0];

db('stages run in the order given and each is recorded with its progress', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const seen: string[] = [];
  const stages: Stage<{ log: string[] }>[] = ['normalize', 'read', 'rank'].map((name) => ({ name, run: async (ctx) => void (seen.push(name), ctx.log.push(name)) }));
  const result = await runStages(p, { courseId, kind: 'generation', now: clock() }, stages, { log: [] });
  assert.deepEqual(seen, ['normalize', 'read', 'rank']);
  assert.equal(result.ok, true);
  const row = await runRow(p, result.runId);
  assert.equal(row.stage, 'rank');
  assert.equal(row.percent, 100);
  assert.ok(row.finished_at && row.error === null);
});

db('a failing stage fails the run with its name and reason, and later stages do not run', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const seen: string[] = [];
  const stages: Stage<object>[] = [
    { name: 'read', run: async () => void seen.push('read') },
    { name: 'check', run: async () => { throw new Error('qa_failed: chapter 3 still has a flagged money claim'); } },
    { name: 'publish', run: async () => void seen.push('publish') },
  ];
  const result = await runStages(p, { courseId, kind: 'generation', now: clock() }, stages, {});
  assert.deepEqual(seen, ['read']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'check');
  assert.match(result.reason, /qa_failed/);
  const row = await runRow(p, result.runId);
  assert.equal(row.stage, 'check');
  assert.match(row.error, /qa_failed/);
  assert.ok(row.finished_at);
  assert.ok(row.percent < 100);
});

db('credits and tokens used by the stages are added up and recorded, even when a later stage fails', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const stages: Stage<object>[] = [
    { name: 'find', run: async (_c, io) => { io.credits(7); io.tokens(1200, 300); } },
    { name: 'reference', run: async (_c, io) => { io.credits(21); io.tokens(5000, 900); throw new Error('boom'); } },
  ];
  const result = await runStages(p, { courseId, kind: 'generation', now: clock() }, stages, {});
  const row = await runRow(p, result.runId);
  assert.equal(row.tavily_credits, 28);
  assert.equal(Number(row.tokens_in), 6200);
  assert.equal(Number(row.tokens_out), 1200);
});

db('a stage that would pass the credit budget is refused before it spends, and the run fails with the reason', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const stages: Stage<object>[] = [{ name: 'reference', run: async (_c, io) => { io.credits(30); io.credits(30); } }];
  const result = await runStages(p, { courseId, kind: 'generation', now: clock(), creditBudget: 50 }, stages, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /credit budget/);
  assert.equal((await runRow(p, result.runId)).tavily_credits, 30); // the second charge never happened
});

db('a run can belong to a version, which survives a failed run unchanged', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id;
  const result = await runStages(p, { courseId, versionId, kind: 'generation', now: clock() }, [{ name: 'x', run: async () => { throw new Error('nope'); } }], {});
  assert.equal((await runRow(p, result.runId)).version_id, versionId);
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [versionId])).rows[0].status, 'building'); // the runner does not decide the version's fate
});

db('a run that approval already queued is taken over instead of a second one being made', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const queued = (await p.query(`INSERT INTO course_runs (course_id, kind, stage, percent, started_at) VALUES ($1, 'generation', 'queued', 0, $2) RETURNING id`, [courseId, T0])).rows[0].id as number;
  const result = await runStages(p, { courseId, kind: 'generation', runId: queued, now: clock() }, [{ name: 'read', run: async () => {} }], {});
  assert.equal(result.runId, queued);
  assert.equal(Number((await p.query(`SELECT count(*) FROM course_runs WHERE course_id = $1`, [courseId])).rows[0].count), 1);
  assert.equal((await runRow(p, queued)).stage, 'read');
});

db('a stage report is given after each stage with the credits and tokens that stage used', async (p) => {
  const courseId = await course(p, await role(p), { status: 'building' });
  const seen: Array<[string, number, number, number]> = [];
  const stages: Stage<object>[] = [
    { name: 'find', run: async (_c, io) => { io.credits(7); io.tokens(100, 20); } },
    { name: 'reference', run: async (_c, io) => { io.credits(21); io.tokens(5000, 900); } },
  ];
  await runStages(p, { courseId, kind: 'generation', now: clock(), onStage: (r) => void seen.push([r.stage, r.credits, r.tokensIn, r.tokensOut]) }, stages, {});
  assert.deepEqual(seen, [['find', 7, 100, 20], ['reference', 21, 5000, 900]]);
});
