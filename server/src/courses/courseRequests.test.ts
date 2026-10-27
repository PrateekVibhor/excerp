// Plan 16, phase 2, step 4: the request log is what the limits count (spec 16, section 5). Source searches count even when cancelled or
// expired, repeat requests for an existing role do not, and the reader is told when they may try again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, publishedCourse, role } from '../../testkit/courseFixtures.ts';
import { createCourseRequests, windowRetry } from './requests.ts';
import { createCourseSettings } from './settings.ts';

const { db } = useCourseDb('requests', { reset: ['course_requests', 'course_settings', 'course_runs'] });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-20T09:00:00.000Z');

function setup(p: pg.Pool) {
  const clock = { now: new Date(T0) };
  const settings = createCourseSettings(p);
  return { clock, settings, requests: createCourseRequests(p, settings, () => clock.now), advance: (ms: number) => void (clock.now = new Date(clock.now.getTime() + ms)) };
}
/** Courses on, and the global caps out of the way, so only the per-reader limits are under test. */
const turnOn = async (s: ReturnType<typeof createCourseSettings>) => {
  await s.set('courses_off', false);
  for (const cap of ['cap.source_searches_per_day', 'cap.generations_per_day', 'cap.refresh_checks_per_day'] as const) await s.set(cap, 1000);
};
const logCount = async (p: pg.Pool, where: string, args: unknown[] = []) => Number((await p.query(`SELECT count(*) FROM course_requests WHERE ${where}`, args)).rows[0].count);

test('windowRetry: no wait under the limit; otherwise the moment enough old entries have aged out', () => {
  const at = (h: number) => new Date(T0.getTime() + h * HOUR);
  assert.equal(windowRetry([at(0), at(1)], 3, DAY), null);
  assert.deepEqual(windowRetry([at(0), at(1), at(2)], 3, DAY), new Date(at(0).getTime() + DAY));
  assert.deepEqual(windowRetry([at(0), at(1), at(2), at(3)], 3, DAY), new Date(at(1).getTime() + DAY), 'over the limit by one: wait for the second to age out');
  assert.equal(windowRetry([], 0, DAY), undefined, 'a limit of zero never frees up');
});

db('Scenario: five source searches a day; the sixth is refused with the time to try again', async (p) => {
  const { requests, settings, advance } = setup(p);
  await turnOn(settings);
  const a = await account(p);
  const r = await role(p);
  const first = T0.getTime();
  for (let i = 0; i < 5; i++) {
    const d = await requests.sourceSearch(a, r);
    assert.equal(d.ok, true, `search ${i + 1}`);
    advance(HOUR);
  }
  const sixth = await requests.sourceSearch(a, r);
  assert.deepEqual([sixth.ok, !sixth.ok && sixth.code], [false, 'source_search_limit']);
  assert.deepEqual(!sixth.ok && sixth.retryAt, new Date(first + DAY), 'when the oldest one ages out');
  assert.equal(await logCount(p, `account_id = $1 AND kind = 'source_search' AND outcome = 'refused'`, [a]), 1, 'the refusal is logged');
  advance(DAY - 5 * HOUR); // now exactly at the retry time
  assert.equal((await requests.sourceSearch(a, r)).ok, true);
});

db('cancelled and expired searches still count; a repeat request for an existing role does not', async (p) => {
  const { requests, settings, advance } = setup(p);
  await turnOn(settings);
  await settings.set('limit.source_searches_per_day', 3);
  const a = await account(p);
  const r = await role(p);
  const one = await requests.sourceSearch(a, r);
  const two = await requests.sourceSearch(a, r);
  assert.ok(one.ok && two.ok);
  await requests.markSourceSearch(one.requestId, 'cancelled');
  await requests.markSourceSearch(two.requestId, 'expired');
  for (let i = 0; i < 5; i++) await requests.servedExisting(a, r); // asking again for a role that already has a course
  const third = await requests.sourceSearch(a, r);
  assert.equal(third.ok, true, 'three counted so far including this one');
  advance(HOUR);
  const fourth = await requests.sourceSearch(a, r);
  assert.equal(fourth.ok, false, 'the two cancelled or expired ones used up the allowance');
  assert.equal(await logCount(p, `account_id = $1 AND outcome = 'served_existing'`, [a]), 5);
});

db('the limit is per reader', async (p) => {
  const { requests, settings } = setup(p);
  await turnOn(settings);
  await settings.set('limit.source_searches_per_day', 1);
  const [a, b] = [await account(p), await account(p)];
  const r = await role(p);
  assert.equal((await requests.sourceSearch(a, r)).ok, true);
  assert.equal((await requests.sourceSearch(a, r)).ok, false);
  assert.equal((await requests.sourceSearch(b, r)).ok, true);
});

db('Scenario: one approval a day and three a month, counted when the reader approves', async (p) => {
  const { requests, settings, advance } = setup(p);
  await turnOn(settings);
  const a = await account(p);
  const r = await role(p);
  const day1 = T0.getTime();
  assert.equal((await requests.approval(a, r)).ok, true);
  const same = await requests.approval(a, r);
  assert.deepEqual([same.ok, !same.ok && same.code, !same.ok && same.retryAt], [false, 'course_limit', new Date(day1 + DAY)]);

  advance(DAY + HOUR);
  assert.equal((await requests.approval(a, r)).ok, true, 'a new day');
  advance(DAY);
  assert.equal((await requests.approval(a, r)).ok, true, 'the third in the month');
  advance(DAY);
  const fourth = await requests.approval(a, r);
  assert.deepEqual([fourth.ok, !fourth.ok && fourth.code], [false, 'course_limit']);
  assert.deepEqual(!fourth.ok && fourth.retryAt, new Date(day1 + 30 * DAY), 'the first approval leaves the month window');
  advance(27 * DAY);
  assert.equal((await requests.approval(a, r)).ok, true);
});

db('Scenario: one refresh per course per reader per 14 days; asking again the same day is the same request', async (p) => {
  const { requests, settings, advance } = setup(p);
  await turnOn(settings);
  const c1 = await publishedCourse(p);
  const c2 = await publishedCourse(p);
  const a = await account(p);
  const b = await account(p);

  const first = await requests.refresh(a, c1.roleId, c1.courseId);
  assert.ok(first.ok && !first.repeat);
  advance(2 * HOUR);
  const again = await requests.refresh(a, c1.roleId, c1.courseId);
  assert.ok(again.ok && again.repeat, 'idempotent within a day');
  assert.equal(await logCount(p, `account_id = $1 AND kind = 'refresh' AND outcome = 'started'`, [a]), 1);

  advance(2 * DAY);
  const early = await requests.refresh(a, c1.roleId, c1.courseId);
  assert.deepEqual([early.ok, !early.ok && early.code, !early.ok && early.retryAt], [false, 'refresh_limit', new Date(T0.getTime() + 14 * DAY)]);
  assert.equal((await requests.refresh(a, c2.roleId, c2.courseId)).ok, true, 'another course');
  assert.equal((await requests.refresh(b, c1.roleId, c1.courseId)).ok, true, 'another reader');

  advance(12 * DAY);
  assert.equal((await requests.refresh(a, c1.roleId, c1.courseId)).ok, true, 'after 14 days');
});

db('a refresh asked for after the pool was checked in the last day is answered "already checked" and does not use the allowance', async (p) => {
  const { requests, settings, clock } = setup(p);
  await turnOn(settings);
  const c = await publishedCourse(p);
  await p.query(`UPDATE courses SET last_checked_at = $2 WHERE id = $1`, [c.courseId, new Date(clock.now.getTime() - 3 * HOUR)]);
  const a = await account(p);
  const d = await requests.refresh(a, c.roleId, c.courseId);
  assert.ok(d.ok && d.alreadyChecked);
  assert.equal(await logCount(p, `account_id = $1 AND outcome = 'served_existing' AND kind = 'refresh'`, [a]), 1);
  await p.query(`UPDATE courses SET last_checked_at = $2 WHERE id = $1`, [c.courseId, new Date(clock.now.getTime() - 30 * HOUR)]);
  const next = await requests.refresh(a, c.roleId, c.courseId);
  assert.ok(next.ok && !next.alreadyChecked);
});

db('limits are read from the settings table each time', async (p) => {
  const { requests, settings } = setup(p);
  await turnOn(settings);
  const a = await account(p);
  const r = await role(p);
  await settings.set('limit.source_searches_per_day', 1);
  assert.equal((await requests.sourceSearch(a, r)).ok, true);
  assert.equal((await requests.sourceSearch(a, r)).ok, false);
  await settings.set('limit.source_searches_per_day', 2);
  assert.equal((await requests.sourceSearch(a, r)).ok, true);
});

db('Scenario: rows older than 90 days are purged and newer ones stay', async (p) => {
  const { requests, settings, clock } = setup(p);
  await turnOn(settings);
  const a = await account(p);
  const r = await role(p);
  const insert = (daysAgo: number) =>
    p.query(`INSERT INTO course_requests (account_id, role_id, kind, outcome, created_at) VALUES ($1, $2, 'source_search', 'started', $3)`, [a, r, new Date(clock.now.getTime() - daysAgo * DAY)]);
  await insert(91);
  await insert(120);
  await insert(89);
  await insert(1);
  assert.equal(await requests.purge(), 2);
  assert.equal(await logCount(p, 'account_id = $1', [a]), 2);
});
