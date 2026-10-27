// The course runner: the part of the worker that picks up what the app queued (a search for a course's sources, then its build) and runs it with the real
// finder and builder. Real SQL; the finder and builder are stubs in most tests and the real ones, with a fake model and search, in the last two.
import assert from 'node:assert/strict';
import pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, course, publishedCourse, publishedListCourse, role, source } from '../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../testkit/fakePipeline.ts';
import { loadConfig } from '../config.ts';
import type { Chat } from '../llm.ts';
import type { LogEvent } from '../pipeline.ts';
import { buildCourse } from './pipeline/build.ts';
import { findCourseSources } from './pipeline/findSources.ts';
import type { Hit, SearchClient } from './pipeline/postings.ts';
import { realRunnerDeps, recordUsage, runCourseQueue, startCourseRunner, type RunnerDeps } from './runner.ts';

const { db } = useCourseDb('runner', { reset: ['roles', 'accounts', 'tracked_companies'] });
type P = pg.Pool;
const NOW = new Date('2026-10-20T12:00:00Z');
const OK = { ok: true as const };
type Call = { kind: 'find' | 'build' | 'refresh'; courseId: string; runId?: number };

/** A course waiting for its sources, with the run the app queued for it. */
async function waiting(p: P, status = 'finding_sources') {
  const requester = await account(p);
  const roleId = await role(p);
  const courseId = await course(p, roleId, { status, requested_by: requester, title: 'a role' });
  const runId = (await p.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'source_finding', $2, 'queued', 0, $3) RETURNING id`, [courseId, requester, NOW])).rows[0].id as number;
  return { requester, roleId, courseId, runId };
}
/** An approved course with the generation run approval queued. */
async function approvedCourse(p: P, over: { status?: string } = {}) {
  const requester = await account(p);
  const roleId = await role(p);
  const courseId = await course(p, roleId, { status: over.status ?? 'building', approved_at: NOW, requested_by: requester, title: 'a role', mode: 'list' });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, started_at) VALUES ($1, $2, 'generation', $3, 'queued', 0, $4) RETURNING id`, [courseId, versionId, requester, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  return { roleId, courseId, versionId, runId };
}
function stubs(p: P, over: Partial<RunnerDeps> = {}) {
  const calls: Call[] = [];
  const log: LogEvent[] = [];
  const deps: RunnerDeps = {
    pool: p, now: () => NOW, log: (e) => log.push(e),
    find: async (courseId, runId) => (calls.push({ kind: 'find', courseId, runId }), OK),
    build: async (courseId) => (calls.push({ kind: 'build', courseId }), OK),
    ...over,
  };
  return { deps, calls, log };
}
const run = async (p: P, id: number) => (await p.query(`SELECT stage, percent, finished_at IS NOT NULL AS done, error FROM course_runs WHERE id = $1`, [id])).rows[0];
const status = async (p: P, courseId: string) => (await p.query(`SELECT status, failure_reason FROM courses WHERE id = $1`, [courseId])).rows[0];

db('a queued source search is claimed and the finder is run for that course with that run, once', async (p) => {
  const w = await waiting(p);
  const s = stubs(p);
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, [{ kind: 'find', courseId: w.courseId, runId: w.runId }]);
  assert.deepEqual([r.status, (r as { found: number }).found], ['ran', 1]);
  assert.notEqual((await run(p, w.runId)).stage, 'queued'); // claimed
  s.calls.length = 0;
  await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, [], 'a run that was claimed is never claimed again');
});

db('an approved course\'s queued generation run is claimed and the builder is run for it, once', async (p) => {
  const a = await approvedCourse(p);
  const s = stubs(p);
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, [{ kind: 'build', courseId: a.courseId }]);
  assert.equal((r as { built: number }).built, 1);
  assert.notEqual((await run(p, a.runId)).stage, 'queued');
  s.calls.length = 0;
  await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, []);
});

db('what is queued is run oldest first, whatever its kind', async (p) => {
  const first = await approvedCourse(p);
  const second = await waiting(p);
  const third = await approvedCourse(p);
  const s = stubs(p);
  await runCourseQueue(s.deps);
  assert.deepEqual(s.calls.map((c) => c.courseId), [first.courseId, second.courseId, third.courseId]);
});

db('a source search that comes back failed ends the course failed with a reason, closes its run, and is not tried again', async (p) => {
  const w = await waiting(p);
  const s = stubs(p, { find: async () => ({ ok: false, reason: 'not enough postings found' }) });
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(await status(p, w.courseId), { status: 'failed', failure_reason: 'find_failed' });
  assert.deepEqual([(await run(p, w.runId)).done, (await run(p, w.runId)).error], [true, 'not enough postings found']);
  assert.equal((r as { failed: number }).failed, 1);
  assert.ok(s.log.some((e) => e.event === 'course_run_failed' && e.kind === 'source_finding' && e.courseId === w.courseId));
});

db('a finder that throws is treated the same, and a reason the finder already gave the course is kept', async (p) => {
  const w = await waiting(p);
  const x = await waiting(p);
  await runCourseQueue(stubs(p, { find: async (id) => { if (id === x.courseId) { await p.query(`UPDATE courses SET status = 'failed', failure_reason = 'not_a_role' WHERE id = $1`, [id]); return { ok: false, reason: 'not_a_role' }; } throw new Error('the search service is down'); } }).deps);
  assert.deepEqual(await status(p, w.courseId), { status: 'failed', failure_reason: 'find_failed' });
  assert.equal((await run(p, w.runId)).error, 'the search service is down');
  assert.deepEqual(await status(p, x.courseId), { status: 'failed', failure_reason: 'not_a_role' });
});

db('a build that throws before it starts ends the course failed and closes its run; one that returns failed leaves the course to the builder', async (p) => {
  const threw = await approvedCourse(p);
  const returned = await approvedCourse(p);
  const s = stubs(p, { build: async (id) => { if (id === threw.courseId) throw new Error('the course has no version being built'); return { ok: false, reason: 'qa_failed: x' }; } });
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(await status(p, threw.courseId), { status: 'failed', failure_reason: 'build_failed' });
  assert.equal((await run(p, threw.runId)).error, 'the course has no version being built');
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [threw.versionId])).rows[0].status, 'failed');
  assert.equal((await status(p, returned.courseId)).status, 'building', 'the builder decides what a returned failure means');
  assert.equal((await run(p, returned.runId)).done, true);
  assert.equal((r as { failed: number }).failed, 2);
});

db('one course failing does not stop the others in the queue', async (p) => {
  const a = await waiting(p);
  const b = await waiting(p);
  const s = stubs(p, { find: async (id) => { if (id === a.courseId) throw new Error('boom'); return OK; } });
  await runCourseQueue(s.deps);
  assert.equal((await status(p, a.courseId)).status, 'failed');
  assert.equal((await run(p, b.runId)).stage === 'queued', false, 'the second was still run');
});

db('a run for a course that is no longer waiting (cancelled or replaced) is closed without running anything', async (p) => {
  const w = await waiting(p, 'cancelled');
  const a = await approvedCourse(p, { status: 'cancelled' });
  const s = stubs(p);
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, []);
  assert.deepEqual([(await run(p, w.runId)).done, (await run(p, w.runId)).error], [true, 'course_not_waiting']);
  assert.deepEqual([(await run(p, a.runId)).done, (await run(p, a.runId)).error], [true, 'course_not_waiting']);
  assert.equal((r as { skipped: number }).skipped, 2);
  assert.equal((await status(p, w.courseId)).status, 'cancelled', 'such a course is left as it is');
});

db('a run that was started and never finished (the worker was stopped) is failed when the runner next starts, and the course with it; queued runs are left', async (p) => {
  const w = await waiting(p);
  const b = await approvedCourse(p);
  await p.query(`UPDATE course_runs SET stage = 'reference', percent = 40 WHERE id = ANY($1)`, [[w.runId, b.runId]]);
  const queued = await waiting(p);
  const s = stubs(p);
  const r = await runCourseQueue(s.deps);
  assert.equal((r as { recovered: number }).recovered, 2);
  for (const id of [w.runId, b.runId]) assert.deepEqual([(await run(p, id)).done, (await run(p, id)).error], [true, 'interrupted']);
  assert.deepEqual(await status(p, w.courseId), { status: 'failed', failure_reason: 'interrupted' });
  assert.deepEqual(await status(p, b.courseId), { status: 'failed', failure_reason: 'interrupted' });
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [b.versionId])).rows[0].status, 'failed');
  assert.deepEqual(s.calls.map((c) => c.courseId), [queued.courseId], 'only the queued one ran');
});

db('two runners never work at once: while one holds the lock the other does nothing, and does not recover its runs', async (p) => {
  const w = await waiting(p);
  await p.query(`UPDATE course_runs SET stage = 'reference' WHERE id = $1`, [w.runId]);
  const holder = await p.connect();
  try {
    await holder.query(`SELECT pg_advisory_lock(hashtext('excerp:course_runner'))`);
    const s = stubs(p);
    assert.deepEqual(await runCourseQueue(s.deps), { status: 'skipped', reason: 'another_run_in_progress' });
    assert.deepEqual(s.calls, []);
    assert.equal((await run(p, w.runId)).done, false);
  } finally {
    await holder.query(`SELECT pg_advisory_unlock(hashtext('excerp:course_runner'))`);
    holder.release();
  }
});

db('a database without the Plan 16 tables is left alone: the runner says so and does not fail', async () => {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const schema = `empty_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const bare = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const log: LogEvent[] = [];
    const r = await runCourseQueue({ pool: bare, log: (e) => log.push(e), find: async () => OK, build: async () => OK });
    assert.deepEqual(r, { status: 'skipped', reason: 'plan_16_tables_missing' });
    assert.ok(log.some((e) => e.event === 'course_runner_skipped' && e.reason === 'plan_16_tables_missing'));
  } finally {
    await bare.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

// ---- with the real finder and builder -------------------------------------------------------------------------------------------------------------------

const body = 'Responsibilities: you will build and run things for customers. Qualifications: experience with systems. '.repeat(14);
const hit = (url: string, title: string): Hit => ({ url, title, text: body });
const finderChat: Chat = async (m) => {
  if (/turn what a person typed/.test(m[0]!.content)) return JSON.stringify({ ok: true, role: 'ml engineer', aliases: [], description: 'Builds and runs machine learning systems.' });
  return JSON.stringify({ same: true, why: 'judged' });
};

db('with the real finder, one queued search becomes one finished run and a course awaiting approval, with no second run row', async (p) => {
  const w = await waiting(p);
  await p.query(`UPDATE roles SET name = 'ml engineer' WHERE id = $1`, [w.roleId]);
  for (let i = 0; i < 9; i++) await p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ($1, $2, 'seed')`, [`Acme ${i}`, `acme${i}.com`]);
  const search: SearchClient = { search: async (q) => (q.includeDomains?.some((d) => d.startsWith('acme')) ? Array.from({ length: 9 }, (_, i) => hit(`https://acme${i}.com/careers/job/${i}`, 'ML Engineer')) : []) };
  const deps: RunnerDeps = { pool: p, now: () => NOW, log: () => {}, find: (courseId, runId) => findCourseSources({ pool: p, chat: finderChat, search, now: () => NOW }, courseId, runId), build: async () => OK };
  const r = await runCourseQueue(deps);
  assert.deepEqual([(r as { found: number }).found, (r as { failed: number }).failed], [1, 0]);
  assert.equal((await status(p, w.courseId)).status, 'awaiting_approval');
  const runs = (await p.query(`SELECT id, percent, finished_at IS NOT NULL AS done FROM course_runs WHERE course_id = $1`, [w.courseId])).rows;
  assert.deepEqual(runs.map((x) => [x.id, x.percent, x.done]), [[w.runId, 100, true]]);
});

db('with the real builder, an approved list course is built and published from the queued run', async (p) => {
  const a = await approvedCourse(p);
  await p.query(`UPDATE roles SET name = 'backend engineer', description = 'Builds and runs services.' WHERE id = $1`, [a.roleId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, a.roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [a.courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  const skills = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
  const model = fakeModel();
  const READ = async () => ({ ok: true as const, text: 'A page that explains the idea in plain words, at some length, for people doing the work. '.repeat(10) });
  const d = { pool: p, chat: model, search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(skills(i), [])]))), youtube: fakeYoutube(), reachable: async () => true, readPage: READ, now: () => NOW };
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, find: async () => OK, build: (courseId) => buildCourse(d, courseId) });
  assert.deepEqual([(r as { built: number }).built, (r as { failed: number }).failed], [1, 0]);
  const c = (await p.query(`SELECT status, published_version FROM courses WHERE id = $1`, [a.courseId])).rows[0];
  assert.deepEqual([c.status, c.published_version === a.versionId], ['ready', true]);
  assert.deepEqual([(await run(p, a.runId)).percent, (await run(p, a.runId)).done], [100, true]);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM course_runs WHERE course_id = $1`, [a.courseId])).rows[0].n, 1);
});

// ---- the timer ------------------------------------------------------------------------------------------------------------------------------------------

const env = { TAVILY_API_KEY: 't', NEBIUS_API_KEY: 'n', NEBIUS_MODEL: 'm', DATABASE_URL: 'postgres://x/y' };

db('the runner is on a timer inside the worker, off unless configured, and polls every COURSE_RUNNER_SECONDS', async (p) => {
  const base = { pool: p, log: () => {}, find: async () => OK, build: async () => OK };
  assert.equal(startCourseRunner({ ...base, config: loadConfig(env) }), undefined);
  const timers: number[] = [];
  const ran: number[] = [];
  const worker = startCourseRunner({ ...base, config: loadConfig({ ...env, COURSE_RUNNER_SECONDS: '15' }), runner: async () => void ran.push(1), setTimer: (_fn, ms) => (timers.push(ms), 1), clearTimer: () => {} });
  assert.ok(worker);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ran, [1], 'it runs at once on start');
  assert.deepEqual(timers, [15_000], 'and then again every 15 seconds');
  await worker!.stop();
});

// ---- the real wiring: credit budgets and the tokens a run used ------------------------------------------------------------------------------------------

const counting = (inner: Chat, per = { prompt_tokens: 100, completion_tokens: 20 }) => (onUsage: (u: typeof per) => void): Chat => async (m) => (onUsage(per), inner(m));
const mlSearch: SearchClient = { search: async (q) => (q.includeDomains?.some((d) => d.startsWith('acme')) ? Array.from({ length: 9 }, (_, i) => hit(`https://acme${i}.com/careers/job/${i}`, 'ML Engineer')) : []) };
async function mlWaiting(p: P) {
  const w = await waiting(p);
  await p.query(`UPDATE roles SET name = 'ml engineer' WHERE id = $1`, [w.roleId]);
  for (let i = 0; i < 9; i++) await p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ($1, $2, 'seed')`, [`Acme ${i}`, `acme${i}.com`]);
  return w;
}

db('a source search through the real wiring records the credits it used and the tokens the model used on its run', async (p) => {
  const w = await mlWaiting(p);
  const real = realRunnerDeps({ config: loadConfig(env), pool: p, now: () => NOW, clients: { chat: counting(finderChat), search: mlSearch } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, ...real });
  assert.equal((r as { found: number }).found, 1, JSON.stringify([r, await run(p, w.runId)]));
  const row = (await p.query(`SELECT tavily_credits, tokens_in::int AS tin, tokens_out::int AS tout FROM course_runs WHERE id = $1`, [w.runId])).rows[0];
  assert.ok(row.tavily_credits > 0 && row.tin > 0 && row.tout > 0, JSON.stringify(row));
  assert.equal(row.tin / 100, row.tout / 20, 'every model call was counted once');
});

db('a source search stops at its credit budget: the run fails with that reason and the course ends failed', async (p) => {
  const w = await mlWaiting(p);
  const real = realRunnerDeps({ config: loadConfig({ ...env, COURSE_FIND_CREDITS: '1' }), pool: p, now: () => NOW, clients: { chat: counting(finderChat), search: mlSearch } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, ...real });
  assert.equal((r as { failed: number }).failed, 1);
  assert.match((await run(p, w.runId)).error, /credit budget of 1/);
  assert.deepEqual(await status(p, w.courseId), { status: 'failed', failure_reason: 'find_failed' });
});

db('a build through the real wiring, with the database library, records its tokens on the run the approval queued', async (p) => {
  const a = await approvedCourse(p);
  await p.query(`UPDATE roles SET name = 'backend engineer', description = 'Builds and runs services.' WHERE id = $1`, [a.roleId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, a.roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [a.courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  const skills = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
  const real = realRunnerDeps({ config: loadConfig(env), pool: p, now: () => NOW, clients: { chat: counting(fakeModel()), search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(skills(i), [])]))), youtube: fakeYoutube(), reachable: async () => true } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, ...real });
  assert.deepEqual([(r as { built: number }).built, (r as { failed: number }).failed], [1, 0], JSON.stringify(await run(p, a.runId)));
  assert.equal((await status(p, a.courseId)).status, 'ready');
  const row = (await p.query(`SELECT tokens_in::int AS tin, tokens_out::int AS tout FROM course_runs WHERE id = $1`, [a.runId])).rows[0];
  assert.ok(row.tin > 0 && row.tin / 100 === row.tout / 20, JSON.stringify(row));
});

db('a real build logs how long each stage took and how many calls it made, without changing the result', async (p) => {
  const a = await approvedCourse(p);
  await p.query(`UPDATE roles SET name = 'backend engineer', description = 'Builds and runs services.' WHERE id = $1`, [a.roleId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, a.roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [a.courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  const skills = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
  const events: Array<Record<string, unknown>> = [];
  const real = realRunnerDeps({ log: (e) => void events.push(e), config: loadConfig(env), pool: p, now: () => NOW, clients: { chat: counting(fakeModel()), search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(skills(i), [])]))), youtube: fakeYoutube(), reachable: async () => true } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: (e: Record<string, unknown>) => void events.push(e), ...real });
  assert.deepEqual([(r as { built: number }).built, (r as { failed: number }).failed], [1, 0], JSON.stringify(await run(p, a.runId)));
  const t = events.find((e) => e.event === 'course_timing') as { stages: Array<{ stage: string; ms: number }>; calls: Record<string, { calls: number }> } | undefined;
  assert.ok(t, JSON.stringify(events));
  assert.deepEqual(t.stages.map((x) => x.stage).slice(0, 3), ['read', 'rank', 'delta']);
  assert.ok(t.calls.model!.calls > 0 && Object.keys(t.calls).some((k) => k.startsWith('search')), JSON.stringify(Object.keys(t.calls)));
  assert.equal((await status(p, a.courseId)).status, 'ready');
});

db('with a judge model named, a real build has it judge the web pages, and the model it names is recorded with each verdict', async (p) => {
  const a = await approvedCourse(p);
  await p.query(`UPDATE roles SET name = 'backend engineer', description = 'Builds and runs services.' WHERE id = $1`, [a.roleId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, a.roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [a.courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  const skills = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
  const events: Array<Record<string, unknown>> = [];
  const judged = fakeModel();
  const real = realRunnerDeps({ log: (e) => void events.push(e), config: loadConfig({ ...env, NEBIUS_JUDGE_MODEL: 'small-judge' }), pool: p, now: () => NOW, clients: { judgeChat: counting(judged), chat: counting(fakeModel()), search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(skills(i), [])]))), youtube: fakeYoutube(), reachable: async () => true } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: (e: Record<string, unknown>) => void events.push(e), ...real });
  assert.deepEqual([(r as { built: number }).built, (r as { failed: number }).failed], [1, 0], JSON.stringify(await run(p, a.runId)));
  assert.ok(judged.labels.length > 0 && judged.labels.every((l) => l === 'page'), `the judge model was asked only to judge pages: ${[...new Set(judged.labels)]}`);
  assert.deepEqual((await p.query(`SELECT DISTINCT judge FROM link_judgments ORDER BY 1`)).rows, [{ judge: 'small-judge|research|1' }]);
  assert.equal((await status(p, a.courseId)).status, 'ready');
});

db('recording usage adds to what the run already has', async (p) => {
  const w = await waiting(p);
  await recordUsage(p, w.runId, { in: 5, out: 2 });
  await recordUsage(p, w.runId, { in: 10, out: 3 });
  const row = (await p.query(`SELECT tokens_in::int AS tin, tokens_out::int AS tout FROM course_runs WHERE id = $1`, [w.runId])).rows[0];
  assert.deepEqual([row.tin, row.tout], [15, 5]);
});

// ---- the overall credit cap (off unless set) --------------------------------------------------------------------------------------------------------------

import { createCourseSettings } from './settings.ts';
async function capReached(p: P, total = 10) {
  await createCourseSettings(p).set('cap.credits_total', total);
  const other = await waiting(p);
  await p.query(`UPDATE course_runs SET tavily_credits = $2, stage = 'record', percent = 100, finished_at = $3 WHERE id = $1`, [other.runId, total, NOW]);
}

db('with the overall credit cap reached, a queued source search is not run: its run and the course are failed with credit_cap', async (p) => {
  await capReached(p);
  const w = await waiting(p);
  const s = stubs(p);
  const r = await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(await status(p, w.courseId), { status: 'failed', failure_reason: 'credit_cap' });
  assert.deepEqual([(await run(p, w.runId)).done, (await run(p, w.runId)).error], [true, 'credit_cap']);
  assert.equal((r as { failed: number }).failed, 1);
});

db('with the cap reached, a queued build is not run either: its version and the course are failed with credit_cap', async (p) => {
  await capReached(p);
  const a = await approvedCourse(p);
  const s = stubs(p);
  await runCourseQueue(s.deps);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(await status(p, a.courseId), { status: 'failed', failure_reason: 'credit_cap' });
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [a.versionId])).rows[0].status, 'failed');
});

db('below the cap, work runs as usual', async (p) => {
  await capReached(p, 100);
  await p.query(`UPDATE course_runs SET tavily_credits = 10`); // 10 of 100 used
  const w = await waiting(p);
  const s = stubs(p);
  await runCourseQueue(s.deps);
  assert.deepEqual(s.calls.map((c) => c.courseId), [w.courseId]);
});

db('through the real wiring a search is held to what is left under the cap, if that is less than its own budget', async (p) => {
  await capReached(p, 10);
  await p.query(`UPDATE course_runs SET tavily_credits = 8 WHERE tavily_credits = 10`); // 8 of 10 used: 2 left
  const w = await mlWaiting(p);
  const real = realRunnerDeps({ config: loadConfig(env), pool: p, now: () => NOW, clients: { chat: counting(finderChat), search: mlSearch } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, ...real });
  assert.equal((r as { failed: number }).failed, 1);
  assert.match((await run(p, w.runId)).error, /credit budget of 2/);
});

// ---- checking a list for new sources (a "refresh now" the reader asked for) -----------------------------------------------------------------------------------

/** A ready list with the check a reader asked for, queued. */
async function refreshQueued(p: P, make: () => Promise<{ courseId: string }> = () => publishedListCourse(p, { concepts: 3, roleName: 'business analyst' })) {
  const c = await make();
  const runId = (await p.query(`INSERT INTO course_runs (course_id, kind, stage, percent, started_at) VALUES ($1, 'refresh', 'queued', 0, $2) RETURNING id`, [c.courseId, NOW])).rows[0].id as number;
  return { ...c, runId };
}
const withRefresh = (p: P, calls: Call[], over: Partial<RunnerDeps> = {}): RunnerDeps => ({
  ...stubs(p).deps, refresh: async (courseId, runId) => (calls.push({ kind: 'refresh', courseId, runId }), OK), ...over,
});

db('a list check a reader asked for is run for that list, with that run, and its run is closed; the list itself is left as it is', async (p) => {
  const q = await refreshQueued(p);
  const calls: Call[] = [];
  const r = await runCourseQueue(withRefresh(p, calls));
  assert.deepEqual(calls, [{ kind: 'refresh', courseId: q.courseId, runId: q.runId }]);
  assert.equal((r as { refreshed: number }).refreshed, 1);
  assert.deepEqual([(await run(p, q.runId)).done, (await run(p, q.runId)).error], [true, null]);
  assert.equal((await status(p, q.courseId)).status, 'ready');
  calls.length = 0;
  await runCourseQueue(withRefresh(p, calls));
  assert.deepEqual(calls, [], 'a check is never run twice');
});

db('a check that throws closes its run with the error and does not fail the list', async (p) => {
  const q = await refreshQueued(p);
  const r = await runCourseQueue(withRefresh(p, [], { refresh: async () => { throw new Error('the model is unreachable'); } }));
  assert.equal((r as { failed: number }).failed, 1);
  assert.deepEqual([(await run(p, q.runId)).done, (await run(p, q.runId)).error], [true, 'the model is unreachable']);
  assert.equal((await status(p, q.courseId)).status, 'ready', 'a list that could not be checked is still a good list');
});

db('a check for something that is not a ready list is closed without running', async (p) => {
  const q = await refreshQueued(p, async () => { const c = await publishedListCourse(p, { concepts: 2, roleName: 'business analyst' }); await p.query(`UPDATE courses SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1`, [c.courseId]); return c; });
  const calls: Call[] = [];
  await runCourseQueue(withRefresh(p, calls));
  assert.deepEqual(calls, []);
  assert.equal((await run(p, q.runId)).error, 'course_not_waiting');
});

db('a refresh of a narrative course is left alone: it is not the runner\'s, so it stays queued as it always did', async (p) => {
  const q = await refreshQueued(p, () => publishedCourse(p));
  const calls: Call[] = [];
  await runCourseQueue(withRefresh(p, calls));
  assert.deepEqual(calls, []);
  assert.deepEqual([(await run(p, q.runId)).stage, (await run(p, q.runId)).done], ['queued', false]);
});

db('a runner given no way to check lists leaves list checks queued', async (p) => {
  const q = await refreshQueued(p);
  await runCourseQueue(stubs(p).deps);
  assert.deepEqual([(await run(p, q.runId)).stage, (await run(p, q.runId)).done], ['queued', false]);
});

db('a check that was started and never finished is closed as interrupted when the runner next starts, and the list is left as it is', async (p) => {
  const q = await refreshQueued(p);
  await p.query(`UPDATE course_runs SET stage = 'starting' WHERE id = $1`, [q.runId]);
  const r = await runCourseQueue(withRefresh(p, []));
  assert.equal((r as { recovered: number }).recovered, 1);
  assert.deepEqual([(await run(p, q.runId)).done, (await run(p, q.runId)).error], [true, 'interrupted']);
  assert.equal((await status(p, q.courseId)).status, 'ready');
});

db('the overall credit cap does not stop a list check: it uses no search credits', async (p) => {
  await capReached(p);
  const q = await refreshQueued(p);
  const calls: Call[] = [];
  await runCourseQueue(withRefresh(p, calls));
  assert.deepEqual(calls.map((c) => c.courseId), [q.courseId]);
});

db('through the real wiring a check of a list the library has nothing new for finishes at once, stamps the check, and records no model use', async (p) => {
  const q = await refreshQueued(p);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'business analyst', $3)`, [await account(p), q.courseId, NOW]); // a list nobody reads is not checked
  const real = realRunnerDeps({ config: loadConfig(env), pool: p, now: () => NOW, clients: { chat: counting(finderChat) } });
  const r = await runCourseQueue({ pool: p, now: () => NOW, log: () => {}, ...real });
  assert.deepEqual([(r as { refreshed: number }).refreshed, (r as { failed: number }).failed], [1, 0]);
  assert.equal((await p.query(`SELECT last_checked_at FROM courses WHERE id = $1`, [q.courseId])).rows[0].last_checked_at.toISOString(), NOW.toISOString());
  assert.deepEqual((await p.query(`SELECT tokens_in::int AS tin, tavily_credits FROM course_runs WHERE id = $1`, [q.runId])).rows[0], { tin: 0, tavily_credits: 0 });
});

