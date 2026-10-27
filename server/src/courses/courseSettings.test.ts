// Plan 16, phase 2, step 4: switches, caps and limits live in a table, so they change without a deploy. A missing 'courses_off' row means
// courses are off.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { COURSE_SETTING_DEFAULTS, createCourseSettings, SettingError } from './settings.ts';

const { db } = useCourseDb('settings', { reset: ['course_requests', 'course_settings', 'course_runs'] });

db('with nothing stored, courses are off and every limit has its default', async (p) => {
  const s = await createCourseSettings(p).get();
  assert.equal(s.coursesOff, true);
  assert.deepEqual(s, COURSE_SETTING_DEFAULTS);
  assert.deepEqual(s.perReader, { sourceSearchesPerDay: 5, approvalsPerDay: 1, approvalsPerMonth: 3, refreshEveryDays: 14, flagsPerDay: 10, readsPerHour: 600 });
  assert.deepEqual(s.global, { sourceSearchesPerDay: 10, generationsPerDay: 8, refreshChecksPerDay: 10 }, 'generous for the testing phase, until a credit-based cap replaces them');
});

db('Scenario: the off switch is read from the table and a change takes effect without a deploy', async (p) => {
  const writer = createCourseSettings(p);
  const reader = createCourseSettings(p); // another instance, as another process would be
  assert.equal((await reader.get()).coursesOff, true);
  await writer.set('courses_off', false);
  assert.equal((await reader.get()).coursesOff, false);
  await writer.set('courses_off', true);
  assert.equal((await reader.get()).coursesOff, true);
});

db('a stored value overrides one default and leaves the rest', async (p) => {
  const store = createCourseSettings(p);
  await store.set('limit.source_searches_per_day', 2);
  await store.set('cap.generations_per_day', 7);
  const s = await store.get();
  assert.equal(s.perReader.sourceSearchesPerDay, 2);
  assert.equal(s.global.generationsPerDay, 7);
  assert.equal(s.perReader.approvalsPerMonth, 3);
  await store.set('limit.source_searches_per_day', 4); // set again replaces
  assert.equal((await store.get()).perReader.sourceSearchesPerDay, 4);
  assert.equal((await p.query(`SELECT count(*) FROM course_settings WHERE key = 'limit.source_searches_per_day'`)).rows[0].count, '1');
});

db('a value that makes no sense is refused and nothing is stored', async (p) => {
  const store = createCourseSettings(p);
  const bad = (key: string, value: unknown) => assert.rejects(store.set(key as never, value), (e: unknown) => e instanceof SettingError);
  await bad('limit.source_searches_per_day', -1);
  await bad('limit.source_searches_per_day', 1.5);
  await bad('limit.source_searches_per_day', '5');
  await bad('courses_off', 'yes');
  await bad('cap.unknown', 1);
  assert.equal((await p.query(`SELECT count(*) FROM course_settings WHERE key IN ('limit.source_searches_per_day', 'courses_off', 'cap.unknown')`)).rows[0].count, '0');
});

db('a stored value that is no longer valid is ignored in favour of the default', async (p) => {
  await p.query(`INSERT INTO course_settings (key, value) VALUES ('limit.approvals_per_day', '"many"'::jsonb), ('courses_off', '1'::jsonb)`);
  const s = await createCourseSettings(p).get();
  assert.equal(s.perReader.approvalsPerDay, 1);
  assert.equal(s.coursesOff, true);
});

db('the testing-phase switches are off by default: business analyst lists are not limited, and there is no credit cap (0 means unlimited)', async (p) => {
  const s = await createCourseSettings(p).get();
  assert.equal(s.limitsOnBaLists, false);
  assert.deepEqual(s.creditCap, { total: 0, baseline: 0 });
});

db('the switch and the credit cap can be set, and a baseline can be set to start counting from now', async (p) => {
  const store = createCourseSettings(p);
  await store.set('limits_on_ba_lists', true);
  await store.set('cap.credits_total', 1500);
  await store.set('cap.credits_baseline', 212);
  const s = await store.get();
  assert.equal(s.limitsOnBaLists, true);
  assert.deepEqual(s.creditCap, { total: 1500, baseline: 212 });
  await assert.rejects(store.set('limits_on_ba_lists', 'yes'), SettingError);
  await assert.rejects(store.set('cap.credits_total', -1), SettingError);
  await assert.rejects(store.set('cap.credits_total', 1.5), SettingError);
});
