// "Refresh now" for a list: when the library has nothing new the answer is instant, otherwise a check is queued for the runner. A list can be checked on demand once an hour
// (for the list, whoever asks); asking again meanwhile just says a check is already waiting, or when to try again. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { publishedListCourse } from '../../testkit/courseFixtures.ts';
import { libraryVersion, saveSource } from './library/db.ts';
import type { LibrarySource } from './library/load.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('refreshnow');
const SLUG = 'business-analyst';
const HOUR = 3_600_000;
const ent = (id: string) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active' }) as LibrarySource;
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    for (const t of ['roles', 'library_sources', 'library_changes', 'library_role_files', 'course_settings']) await h.pool.query(`TRUNCATE ${t} CASCADE`);
    h.clock.now = new Date('2026-10-10T12:00:00.000Z');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const refresh = (token: string | undefined, id: string) => h.call(token, 'POST', `/courses/${id}/refresh`, {});
const runs = async (id: string) => (await h.rows(`SELECT kind, stage, finished_at IS NOT NULL AS done FROM course_runs WHERE course_id = $1 AND kind = 'refresh' ORDER BY id`, [id]));

/** A ready business analyst list the library has already been checked against; `newer` adds a source the list has not been rated against. */
async function list(readers: UserKey[], newer = false) {
  const tokens = Object.fromEntries(await Promise.all(readers.map(async (u) => [u, (await h.signIn(u)).token])));
  const c = await publishedListCourse(h.pool, { concepts: 4, roleName: 'business analyst' });
  await h.pool.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(h.pool, ent('lib-one'), SLUG, 'seed');
  await h.pool.query(`UPDATE list_concepts SET library_version = $2 WHERE course_id = $1`, [c.courseId, await libraryVersion(h.pool)]);
  for (const u of readers) await h.pool.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'business analyst', now())`, [await idOf(u), c.courseId]);
  if (newer) await saveSource(h.pool, ent('new-a'), SLUG, 'finder');
  return { ...c, tokens: tokens as Record<UserKey, string> };
}

ct('with nothing new in the library the answer is at once "up to date": no check is queued, the list is stamped as checked, and nothing is used up', async () => {
  const c = await list(['alice']);
  for (let i = 0; i < 3; i++) {
    const res = await refresh(c.tokens.alice, c.courseId);
    assert.deepEqual([res.statusCode, res.json()], [200, { course_id: c.courseId, status: 'up_to_date' }]);
  }
  assert.deepEqual(await runs(c.courseId), []);
  assert.equal((await h.rows(`SELECT last_checked_at FROM courses WHERE id = $1`, [c.courseId]))[0].last_checked_at.toISOString(), h.clock.now.toISOString());
});

ct('with a new source in the library a check is queued for the runner, and asking again while it waits is the same check', async () => {
  const c = await list(['alice'], true);
  const first = await refresh(c.tokens.alice, c.courseId);
  assert.deepEqual([first.statusCode, first.json()], [202, { course_id: c.courseId, status: 'queued' }]);
  assert.deepEqual(await runs(c.courseId), [{ kind: 'refresh', stage: 'queued', done: false }]);
  const again = await refresh(c.tokens.alice, c.courseId);
  assert.deepEqual([again.statusCode, again.json()], [200, { course_id: c.courseId, status: 'queued', repeat: true }]);
  assert.equal((await runs(c.courseId)).length, 1);
});

ct('a list can be checked on demand once an hour: until then the answer is refresh_limit with when to try again, and after the hour it can be checked again', async () => {
  const c = await list(['alice'], true);
  assert.equal((await refresh(c.tokens.alice, c.courseId)).statusCode, 202);
  await h.pool.query(`UPDATE course_runs SET finished_at = now() WHERE kind = 'refresh'`); // the check has run
  h.clock.now = new Date(h.clock.now.getTime() + 20 * 60_000);
  const early = await refresh(c.tokens.alice, c.courseId);
  assert.deepEqual([early.statusCode, early.json().error, early.json().retry_at], [429, 'refresh_limit', '2026-10-10T13:00:00.000Z']);
  h.clock.now = new Date(h.clock.now.getTime() + 41 * 60_000);
  const later = await refresh(c.tokens.alice, c.courseId);
  assert.deepEqual([later.statusCode, later.json().status], [202, 'queued']);
  assert.equal((await runs(c.courseId)).length, 2);
});

ct('the hour is for the list, whoever asks: another reader of the same shared list is told the same', async () => {
  const c = await list(['alice', 'bob'], true);
  assert.equal((await refresh(c.tokens.alice, c.courseId)).statusCode, 202);
  await h.pool.query(`UPDATE course_runs SET finished_at = now() WHERE kind = 'refresh'`);
  const res = await refresh(c.tokens.bob, c.courseId);
  assert.deepEqual([res.statusCode, res.json().error], [429, 'refresh_limit']);
});

ct('only a reader of the list can ask, and with courses off the answer is courses_off', async () => {
  const c = await list(['alice'], true);
  const bob = await h.signIn('bob');
  assert.equal((await refresh(bob.token, c.courseId)).statusCode, 404);
  assert.equal((await refresh(undefined, c.courseId)).statusCode, 401);
  await createCourseSettings(h.pool).set('courses_off', true);
  const res = await refresh(c.tokens.alice, c.courseId);
  assert.deepEqual([res.statusCode, res.json()], [503, { error: 'courses_off' }]);
});
