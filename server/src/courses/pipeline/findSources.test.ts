import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, course, role } from '../../../testkit/courseFixtures.ts';
import type { Chat } from '../../llm.ts';
import { findCourseSources } from './findSources.ts';
import type { Hit, SearchClient, SearchParams } from './postings.ts';

const { db } = useCourseDb('findsrc', { reset: ['roles', 'tracked_companies', 'accounts'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const body = 'Responsibilities: you will build and run things for customers. Qualifications: experience with systems. '.repeat(14);
const hit = (url: string, title: string): Hit => ({ url, title, text: body });

function setup(hits: (p: SearchParams) => Hit[]) {
  const calls: SearchParams[] = [];
  const search: SearchClient = { search: async (p) => (calls.push(p), hits(p)) };
  const chat: Chat = async (m) => {
    if (/turn what a person typed/.test(m[0]!.content)) return JSON.stringify({ ok: true, role: 'ml engineer', aliases: ['machine learning engineer'], description: 'Builds and runs machine learning systems.' });
    return JSON.stringify({ same: !/Intern/.test(m.at(-1)!.content), why: 'judged' });
  };
  return { search, chat, calls };
}
async function pendingRole(p: import('pg').Pool, name = 'ml engineer') {
  const requester = await account(p);
  const roleId = await role(p, name, '');
  for (let i = 0; i < 9; i++) await p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ($1, $2, 'seed')`, [`Acme ${i}`, `acme${i}.com`]);
  const courseId = await course(p, roleId, { status: 'finding_sources', requested_by: requester, title: name });
  return { requester, roleId, courseId };
}
const nine = (p: SearchParams) => (p.includeDomains?.some((d) => d.startsWith('acme')) ? Array.from({ length: 9 }, (_, i) => hit(`https://acme${i}.com/careers/job/${i}`, i % 2 ? 'ML Engineer' : 'Machine Learning Engineer, Vision')) : []);

db('source finding records the role, finds the postings and leaves the course awaiting approval with nothing generated', async (p) => {
  const { courseId, roleId } = await pendingRole(p);
  const s = setup(nine);
  const r = await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  assert.equal(r.ok, true);
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0].status, 'awaiting_approval');
  assert.equal((await p.query(`SELECT description FROM roles WHERE id = $1`, [roleId])).rows[0].description, 'Builds and runs machine learning systems.');
  const pool = (await p.query(`SELECT s.company, s.role_title, s.match, s.counts_for_criticality FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 AND cs.use = 'pool' ORDER BY s.company`, [courseId])).rows;
  assert.equal(pool.length, 9);
  assert.ok(pool.every((x) => x.counts_for_criticality && ['exact', 'alias'].includes(x.match)));
  assert.equal((await p.query(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [courseId])).rows[0].count, '0'); // nothing is built before approval
  const run = (await p.query(`SELECT kind, tavily_credits, stage FROM course_runs WHERE course_id = $1`, [courseId])).rows[0];
  assert.equal(run.kind, 'source_finding');
  assert.equal(run.tavily_credits, s.calls.length);
});

db('near-matches are listed as not used with the reason, a judged-same similar title counts and is learned as an alias', async (p) => {
  const { courseId, roleId } = await pendingRole(p);
  const s = setup((q) => (q.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'ML Engineer'), hit('https://acme1.com/careers/job/2', 'Software Engineer, ML Platform'), hit('https://acme2.com/careers/job/3', 'ML Engineer Intern - Research'), hit('https://acme3.com/careers/job/4', 'Marketing Manager')] : []));
  await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  const rows = (await p.query(`SELECT s.company, s.match, cs.use, cs.reason FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 ORDER BY s.company`, [courseId])).rows;
  assert.deepEqual(rows.map((r) => [r.company, r.use, r.match]), [['Acme 0', 'pool', 'exact'], ['Acme 1', 'pool', 'alias'], ['Acme 2', 'not_used', 'similar']]);
  assert.match(rows[2].reason, /only resembles/); // a different role (the marketing manager) is not listed at all
  assert.equal((await p.query(`SELECT count(*) FROM role_aliases WHERE role_id = $1 AND title_seen = 'software engineer, ml platform'`, [roleId])).rows[0].count, '1');
});

db('a role the model refuses ends the course failed with the reason, and nothing is searched', async (p) => {
  const { courseId } = await pendingRole(p, 'how do i hurt someone');
  const s = setup(nine);
  const refuse: Chat = async () => JSON.stringify({ ok: false, reason: 'not a job role' });
  const r = await findCourseSources({ pool: p, chat: refuse, search: s.search, now: () => NOW }, courseId);
  assert.equal(r.ok, false);
  assert.equal(s.calls.length, 0);
  const c = (await p.query(`SELECT status, failure_reason FROM courses WHERE id = $1`, [courseId])).rows[0];
  assert.deepEqual([c.status, c.failure_reason], ['failed', 'not a job role']);
});

db('fewer than eight matches still reaches the approval step, where the reader is told the evidence is thin', async (p) => {
  const { courseId } = await pendingRole(p);
  const s = setup((q) => (q.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'ML Engineer')] : []));
  const r = await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  assert.equal(r.ok, true);
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0].status, 'awaiting_approval');
  assert.equal((await p.query(`SELECT count(*) FROM course_sources WHERE course_id = $1 AND use = 'pool'`, [courseId])).rows[0].count, '1');
});

async function withPaste(p: import('pg').Pool, text: string | null, visibility = 'private', name = 'ml engineer') {
  const r = await pendingRole(p, name);
  await p.query(`UPDATE courses SET visibility = $2, owner_account_id = $3 WHERE id = $1`, [r.courseId, visibility, visibility === 'private' ? r.requester : null]);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'ml engineer', $3, $4)`, [r.requester, r.courseId, text, NOW]);
  return r;
}
const readerRows = async (p: import('pg').Pool, courseId: string) => (await p.query(`SELECT s.origin, s.visibility, s.owner_account_id, s.url, s.company, s.role_title, s.counts_for_criticality AS counts, s.status, cs.use, cs.state FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 AND cs.use = 'reader'`, [courseId])).rows;

db('a pasted description is registered as the reader\'s own source: private, no link, never counted, waiting for approval like the rest', async (p) => {
  const { courseId, requester } = await withPaste(p, 'Machine learning engineer. Skills: python, pytorch.');
  const s = setup(nine);
  assert.equal((await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId)).ok, true);
  const rows = await readerRows(p, courseId);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].origin, rows[0].visibility, rows[0].owner_account_id, rows[0].url, rows[0].counts, rows[0].use, rows[0].state], ['user_paste', 'private', requester, null, false, 'reader', 'proposed']);
  assert.equal(rows[0].role_title, 'ml engineer');
  assert.equal((await p.query(`SELECT count(*) FROM course_sources WHERE course_id = $1 AND use = 'pool'`, [courseId])).rows[0].count, '9', 'the market postings are found as before');
});

db('no pasted description, no reader source: a shared course, a private one with nothing pasted, and a blank paste', async (p) => {
  for (const [i, [text, vis]] of ([[null, 'shared'], [null, 'private'], ['   ', 'private']] as const).entries()) {
    await p.query(`DELETE FROM tracked_companies`);
    const { courseId } = await withPaste(p, text, vis, `ml engineer ${i}`);
    const s = setup(nine);
    await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
    assert.deepEqual(await readerRows(p, courseId), [], `${vis} ${JSON.stringify(text)}`);
  }
});

db('finding sources again for the same course (a swapped posting) does not register the description twice', async (p) => {
  const { courseId } = await withPaste(p, 'Machine learning engineer. Skills: python.');
  const s = setup(nine);
  await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  await p.query(`UPDATE courses SET status = 'finding_sources' WHERE id = $1`, [courseId]);
  await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  assert.equal((await readerRows(p, courseId)).length, 1);
  assert.equal((await p.query(`SELECT count(*) FROM sources WHERE origin = 'user_paste'`)).rows[0].count, '1');
});

db('given the run the app already queued, source finding uses that run and does not make a second', async (p) => {
  const { courseId, requester } = await pendingRole(p);
  const queued = (await p.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'source_finding', $2, 'queued', 0, $3) RETURNING id`, [courseId, requester, NOW])).rows[0].id as number;
  const s = setup(nine);
  const r = await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId, queued);
  assert.deepEqual([r.ok, r.runId], [true, queued]);
  const runs = (await p.query(`SELECT id, stage, percent, finished_at IS NOT NULL AS done, tavily_credits FROM course_runs WHERE course_id = $1`, [courseId])).rows;
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].id, runs[0].percent, runs[0].done, runs[0].tavily_credits], [queued, 100, true, s.calls.length]);
});

db('finding no similar postings at all is not a failure: the course waits for approval with just what the reader gave', async (p) => {
  const { courseId } = await pendingRole(p);
  const s = setup(() => []);
  const r = await findCourseSources({ pool: p, chat: s.chat, search: s.search, now: () => NOW }, courseId);
  assert.equal(r.ok, true);
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0].status, 'awaiting_approval');
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM course_sources WHERE course_id = $1 AND use = 'pool'`, [courseId])).rows[0].n, 0);
});

