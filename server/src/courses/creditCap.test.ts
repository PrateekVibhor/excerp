// The overall safety cap on search credits across all readers. The mechanism is built and tested here, and it is OFF by default: a cap of 0 means unlimited. When it is on, counting
// starts from a baseline, new requests are refused with credit_cap once the cap is reached, and the runner stops queued work with that reason.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, course, role } from '../../testkit/courseFixtures.ts';
import { creditCapReached, creditsRemaining, creditsUsed, createCourseRequests } from './requests.ts';
import { createCourseSettings } from './settings.ts';

const { db } = useCourseDb('creditcap', { reset: ['course_requests', 'course_settings', 'course_runs'] });
const NOW = new Date('2026-10-20T09:00:00.000Z');

async function setup(p: pg.Pool, cap?: { total?: number; baseline?: number }) {
  const settings = createCourseSettings(p);
  await settings.set('courses_off', false);
  if (cap?.total !== undefined) await settings.set('cap.credits_total', cap.total);
  if (cap?.baseline !== undefined) await settings.set('cap.credits_baseline', cap.baseline);
  return { settings, requests: createCourseRequests(p, settings, () => NOW) };
}
/** A course with no runs, so every credit in a test is one the test recorded. */
const bare = async (p: pg.Pool) => {
  const roleId = await role(p);
  return { roleId, courseId: await course(p, roleId) };
};
/** Credits recorded on a course's runs, as the runner records them. */
async function spent(p: pg.Pool, courseId: string, credits: number) {
  await p.query(`INSERT INTO course_runs (course_id, kind, stage, percent, tavily_credits, started_at, finished_at) VALUES ($1, 'source_finding', 'record', 100, $2, $3, $3)`, [courseId, credits, NOW]);
}
const codeOf = (d: { ok: boolean; code?: string }) => (d.ok ? 'ok' : d.code);

db('with no cap set (0) nothing is ever refused for credits, however many have been used', async (p) => {
  const { settings, requests } = await setup(p);
  const c = await bare(p);
  await spent(p, c.courseId, 50_000);
  const s = await settings.get();
  assert.deepEqual([await creditCapReached(p, s), await creditsRemaining(p, s)], [false, null]);
  const a = await account(p);
  assert.equal(codeOf(await requests.sourceSearch(a, await role(p))), 'ok');
  assert.equal(codeOf(await requests.approval(a, c.roleId, c.courseId)), 'ok');
});

db('credits used are the sum recorded on all course runs, less the baseline', async (p) => {
  const { settings } = await setup(p, { total: 100, baseline: 30 });
  const c = await bare(p);
  await spent(p, c.courseId, 40);
  await spent(p, c.courseId, 25);
  const s = await settings.get();
  assert.equal(await creditsUsed(p, s), 35, '65 recorded, 30 before the baseline');
  assert.equal(await creditsRemaining(p, s), 65);
});

db('once the cap is reached a new search and an approval are refused with credit_cap, for every kind of course', async (p) => {
  const { requests } = await setup(p, { total: 100 });
  const c = await bare(p);
  const a = await account(p);
  await spent(p, c.courseId, 99);
  assert.equal(codeOf(await requests.sourceSearch(a, c.roleId)), 'ok', 'one credit is still left');
  await spent(p, c.courseId, 1);
  assert.equal(codeOf(await requests.sourceSearch(a, c.roleId)), 'credit_cap');
  assert.equal(codeOf(await requests.sourceSearch(a, c.roleId, null, { independent: true })), 'credit_cap', 'a business analyst list is not an exception');
  assert.equal(codeOf(await requests.approval(a, c.roleId, c.courseId)), 'credit_cap');
  assert.equal(codeOf(await requests.approval(a, c.roleId, c.courseId, { independent: true })), 'credit_cap');
});

db('a baseline starts the count again from now: the same recorded credits no longer reach the cap', async (p) => {
  const { settings, requests } = await setup(p, { total: 100 });
  const c = await bare(p);
  await spent(p, c.courseId, 150);
  const a = await account(p);
  assert.equal(codeOf(await requests.sourceSearch(a, c.roleId)), 'credit_cap');
  await settings.set('cap.credits_baseline', 150);
  assert.equal(codeOf(await requests.sourceSearch(a, c.roleId)), 'ok');
  assert.equal(await creditsRemaining(p, await settings.get()), 100);
});

db('remaining credits never go below zero, even when a run has passed the cap', async (p) => {
  const { settings } = await setup(p, { total: 10 });
  const c = await bare(p);
  await spent(p, c.courseId, 14);
  assert.equal(await creditsRemaining(p, await settings.get()), 0);
});
