// Plan 16, phase 2, step 4: the off switch and the global caps sit on top of the per-reader limits. The reader's own limit is reported
// first; each answer carries the code the API will use and when to try again.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, publishedCourse, role } from '../../testkit/courseFixtures.ts';
import { createCourseRequests } from './requests.ts';
import { createCourseSettings } from './settings.ts';

const { db } = useCourseDb('limits', { reset: ['course_requests', 'course_settings', 'course_runs'] });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-20T09:00:00.000Z');

function setup(p: pg.Pool) {
  const clock = { now: new Date(T0) };
  const settings = createCourseSettings(p);
  return { clock, settings, requests: createCourseRequests(p, settings, () => clock.now), advance: (ms: number) => void (clock.now = new Date(clock.now.getTime() + ms)) };
}
const codeOf = (d: { ok: boolean; code?: string }) => (d.ok ? 'ok' : d.code);

db('Scenario: with courses off, every request is refused with courses_off and nothing is recorded', async (p) => {
  const { requests } = setup(p); // nothing stored: off
  const a = await account(p);
  const r = await role(p);
  const c = await publishedCourse(p);
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'courses_off');
  assert.equal(codeOf(await requests.approval(a, r)), 'courses_off');
  assert.equal(codeOf(await requests.refresh(a, c.roleId, c.courseId)), 'courses_off');
  assert.equal((await p.query(`SELECT count(*) FROM course_requests WHERE account_id = $1`, [a])).rows[0].count, '0');
});

db('turning courses on and off again changes the very next answer', async (p) => {
  const { requests, settings } = setup(p);
  const a = await account(p);
  const r = await role(p);
  await settings.set('courses_off', false);
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'ok');
  await settings.set('courses_off', true);
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'courses_off');
});

db('Scenario: the global daily cap on source searches stops everyone, and says when it frees up', async (p) => {
  const { requests, settings, advance } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('cap.source_searches_per_day', 3);
  const readers = [await account(p), await account(p), await account(p), await account(p)];
  const r = await role(p);
  for (let i = 0; i < 3; i++) {
    assert.equal(codeOf(await requests.sourceSearch(readers[i]!, r)), 'ok');
    advance(HOUR);
  }
  const blocked = await requests.sourceSearch(readers[3]!, r);
  assert.equal(codeOf(blocked), 'source_search_cap');
  assert.deepEqual(!blocked.ok && blocked.retryAt, new Date(T0.getTime() + DAY));
  advance(DAY - 3 * HOUR);
  assert.equal(codeOf(await requests.sourceSearch(readers[3]!, r)), 'ok', 'the first search has aged out');
});

db('a repeat request for an existing role is not stopped by the global cap', async (p) => {
  const { requests, settings } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('cap.source_searches_per_day', 1);
  const [a, b] = [await account(p), await account(p)];
  const r = await role(p);
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'ok');
  assert.equal(codeOf(await requests.sourceSearch(b, r)), 'source_search_cap');
  const served = await requests.servedExisting(b, r);
  assert.equal(served.ok, true);
});

db('the reader\'s own limit is reported before a global cap', async (p) => {
  const { requests, settings } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('limit.source_searches_per_day', 1);
  await settings.set('cap.source_searches_per_day', 1);
  const a = await account(p);
  const r = await role(p);
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'ok');
  assert.equal(codeOf(await requests.sourceSearch(a, r)), 'source_search_limit');
});

db('the global cap on generations counts approvals from everyone', async (p) => {
  const { requests, settings, advance } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('cap.generations_per_day', 2);
  const readers = [await account(p), await account(p), await account(p)];
  const r = await role(p);
  assert.equal(codeOf(await requests.approval(readers[0]!, r)), 'ok');
  advance(HOUR);
  assert.equal(codeOf(await requests.approval(readers[1]!, r)), 'ok');
  const third = await requests.approval(readers[2]!, r);
  assert.equal(codeOf(third), 'generation_cap');
  assert.deepEqual(!third.ok && third.retryAt, new Date(T0.getTime() + DAY));
});

db('the global cap on refresh checks counts every refresh run, scheduled ones included', async (p) => {
  const { requests, settings, clock } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('cap.refresh_checks_per_day', 2);
  const c = await publishedCourse(p);
  const [a, b] = [await account(p), await account(p)];
  for (const hoursAgo of [5, 2]) // two scheduled runs, no reader involved
    await p.query(`INSERT INTO course_runs (course_id, kind, stage, started_at) VALUES ($1, 'refresh', 'recheck', $2)`, [c.courseId, new Date(clock.now.getTime() - hoursAgo * HOUR)]);
  const blocked = await requests.refresh(a, c.roleId, c.courseId);
  assert.equal(codeOf(blocked), 'refresh_cap');
  assert.deepEqual(!blocked.ok && blocked.retryAt, new Date(clock.now.getTime() - 5 * HOUR + DAY));
  await settings.set('cap.refresh_checks_per_day', 3);
  assert.equal(codeOf(await requests.refresh(b, c.roleId, c.courseId)), 'ok');
});

db('a refused request is logged as refused and does not use up the allowance', async (p) => {
  const { requests, settings } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('cap.source_searches_per_day', 1);
  const [a, b] = [await account(p), await account(p)];
  const r = await role(p);
  await requests.sourceSearch(a, r);
  for (let i = 0; i < 4; i++) assert.equal(codeOf(await requests.sourceSearch(b, r)), 'source_search_cap');
  const counted = await p.query(`SELECT count(*) FROM course_requests WHERE kind = 'source_search' AND outcome IN ('started', 'cancelled', 'expired')`);
  assert.equal(counted.rows[0].count, '1');
  assert.equal((await p.query(`SELECT count(*) FROM course_requests WHERE outcome = 'refused'`)).rows[0].count, '4');
});

db('two requests from one reader at the same moment cannot both take the last place', async (p) => {
  const { requests, settings } = setup(p);
  await settings.set('courses_off', false);
  await settings.set('limit.source_searches_per_day', 1);
  const a = await account(p);
  const r = await role(p);
  const results = await Promise.all([requests.sourceSearch(a, r), requests.sourceSearch(a, r), requests.sourceSearch(a, r), requests.sourceSearch(a, r)]);
  assert.equal(results.filter((d) => d.ok).length, 1);
});

db('a request waits for the reader\'s lock, so the check and the write happen together', async (p) => {
  const { requests, settings } = setup(p);
  await settings.set('courses_off', false);
  const a = await account(p);
  const r = await role(p);
  const holder = await p.connect(); // someone else holding this reader's lock, as a request in flight would
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [a]);
    let settled = false;
    const pending = requests.sourceSearch(a, r).then((d) => ((settled = true), d));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false, 'it has to wait');
    await holder.query('COMMIT');
    assert.equal(codeOf(await pending), 'ok');
  } finally {
    holder.release();
  }
});
