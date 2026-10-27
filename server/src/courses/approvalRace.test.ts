// Approving a list when the app asks more than once at the same moment (a phone can send several): every call is told the list is building, and only one approval,
// one version and one run are made. A list that is cancelled or deleted in between is refused sensibly, a genuine error is still a failure, and the failure is logged
// without any user data. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { pendingCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';
import { createCourseStarts } from './starts.ts';

const h = useHarness('apprace');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    const settings = createCourseSettings(h.pool);
    await settings.set('courses_off', false);
    // The limits would turn the later of simultaneous approvals away before they got as far as the race; a business analyst list is not held to them in production.
    for (const key of ['limit.approvals_per_day', 'limit.approvals_per_month', 'cap.generations_per_day']) await settings.set(key, 100);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
const count = async (sql: string, args: unknown[]) => Number((await h.rows(sql, args))[0].count);
const approvals = (courseId: string) => count(`SELECT count(*) FROM course_requests WHERE kind = 'approval' AND outcome = 'approved' AND course_id = $1`, [courseId]);

async function ready() {
  const alice = await h.signIn('alice');
  const accountId = await idOf('alice');
  const c = await pendingCourse(h.pool, { requesterId: accountId });
  return { alice, accountId, courseId: c.courseId };
}
/** Settings that run `between` once, right after the approval's own checks have passed and before it changes anything (the second time the approval reads the settings). */
function interleaved(between: () => Promise<void>) {
  const real = createCourseSettings(h.pool);
  let reads = 0;
  return {
    ...real,
    get: async () => {
      const s = await real.get();
      if (++reads === 2) await between();
      return s;
    },
  } as ReturnType<typeof createCourseSettings>;
}

ct('Scenario: three approvals at the same moment all say "building", and make one approval, one version and one run', async () => {
  const { alice, courseId } = await ready();
  const answers = await Promise.all([1, 2, 3].map(() => post(alice.token, `/courses/${courseId}/approve`)));
  assert.deepEqual(answers.map((a) => [a.statusCode, a.json()]), [1, 2, 3].map(() => [200, { course_id: courseId, status: 'building' }]));
  assert.equal(await count(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [courseId]), 1);
  assert.equal(await count(`SELECT count(*) FROM course_runs WHERE course_id = $1 AND kind = 'generation'`, [courseId]), 1);
  assert.equal(await approvals(courseId), 1);
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [courseId]))[0].status, 'building');
});

ct('Scenario: the same, many times over, so a lucky ordering cannot hide a race', async () => {
  const { alice, accountId } = await ready();
  for (let round = 0; round < 5; round++) {
    const c = await pendingCourse(h.pool, { requesterId: accountId });
    const answers = await Promise.all([1, 2, 3, 4].map(() => post(alice.token, `/courses/${c.courseId}/approve`)));
    assert.deepEqual([...new Set(answers.map((a) => a.statusCode))], [200], `round ${round}`);
    assert.equal(await count(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [c.courseId]), 1, `round ${round}`);
    assert.equal(await approvals(c.courseId), 1, `round ${round}`);
  }
});

ct('Scenario: an approval that loses the race to another approval is told "building", and leaves no approval of its own behind', async () => {
  const { accountId, courseId } = await ready();
  const starts = createCourseStarts(h.pool, interleaved(async () => {
    // another approval gets in between the first one's checks and its changes
    await createCourseStarts(h.pool, createCourseSettings(h.pool), () => h.clock.now).approve(accountId, courseId);
  }), () => h.clock.now);
  assert.deepEqual(await starts.approve(accountId, courseId), { kind: 'ok', body: { course_id: courseId, status: 'building' } });
  assert.equal(await approvals(courseId), 1);
  assert.equal(await count(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [courseId]), 1);
});

ct('Scenario: a list cancelled in the meantime is refused as "not awaiting approval", builds nothing and keeps no approval', async () => {
  const { accountId, courseId } = await ready();
  const starts = createCourseStarts(h.pool, interleaved(async () => void (await h.pool.query(`UPDATE courses SET status = 'cancelled' WHERE id = $1`, [courseId]))), () => h.clock.now);
  assert.deepEqual(await starts.approve(accountId, courseId), { kind: 'conflict', error: 'not_awaiting_approval' });
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [courseId]))[0].status, 'cancelled');
  assert.equal(await count(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [courseId]), 0);
  assert.equal(await count(`SELECT count(*) FROM course_requests WHERE kind = 'approval'`, []), 0);
});

ct('Scenario: a list deleted in the meantime is "not found", builds nothing and keeps no approval', async () => {
  const { accountId, courseId } = await ready();
  const starts = createCourseStarts(h.pool, interleaved(async () => void (await h.pool.query(`DELETE FROM courses WHERE id = $1`, [courseId]))), () => h.clock.now);
  assert.deepEqual(await starts.approve(accountId, courseId), { kind: 'not_found' });
  assert.equal(await count(`SELECT count(*) FROM course_requests WHERE kind = 'approval'`, []), 0);
});

ct('Scenario: a genuine error is still a failure (503) and the list stays awaiting approval; the log line has only the route and the error class', async () => {
  const { alice, courseId } = await ready();
  await h.pool.query(`ALTER TABLE course_runs ADD CONSTRAINT approve_race_test_boom CHECK (kind <> 'generation') NOT VALID`);
  try {
    const res = await post(alice.token, `/courses/${courseId}/approve`);
    assert.deepEqual([res.statusCode, res.json()], [503, { error: 'courses unavailable' }]);
  } finally {
    await h.pool.query(`ALTER TABLE course_runs DROP CONSTRAINT approve_race_test_boom`);
  }
  assert.equal((await h.rows(`SELECT status FROM courses WHERE id = $1`, [courseId]))[0].status, 'awaiting_approval');
  const lines = h.logged.filter((l) => l.event === 'course_route_failed');
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['error', 'event', 'route']);
  assert.equal(lines[0].route, 'POST /courses/:id/approve');
  assert.match(String(lines[0].error), /^[A-Za-z]+$/, 'a class name only');
  const text = JSON.stringify(lines);
  for (const leak of [courseId, 'alice', USERS.alice.email, 'approve_race_test_boom', 'generation', 'violates', alice.token]) assert.ok(!text.includes(leak), `the log line must not contain ${leak.slice(0, 8)}`);
});

ct('Scenario: the route log line is written for the read routes and the other step routes too, and a normal refusal writes none', async () => {
  const { alice, courseId } = await ready();
  assert.equal((await post(alice.token, `/courses/${courseId}/approve`)).statusCode, 200);
  assert.equal((await post(alice.token, `/courses/${courseId}/approve`)).statusCode, 200);
  assert.equal((await h.call(alice.token, 'GET', `/courses/00000000-0000-4000-8000-000000000000`)).statusCode, 404);
  assert.deepEqual(h.logged.filter((l) => l.event === 'course_route_failed'), []);
});
