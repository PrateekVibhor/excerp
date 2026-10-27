// A reader's lists: what the list shows for each (title, status, mini coverage, new coverage, when it was last used), opening a list so the order follows use, renaming
// a list for the reader alone, and deleting one from the reader's own view only. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { publishedListCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('mylists');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await h.pool.query('TRUNCATE library_sources CASCADE');
    await h.pool.query('TRUNCATE course_settings');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
const patch = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'PATCH', url, payload);
const enrol = (accountId: string, courseId: string, at: string) => h.pool.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at, created_at) VALUES ($1, $2, 'business analyst', $3, $3)`, [accountId, courseId, at]);
type Mine = { id: string; custom_title: string | null; last_active_at: string; created_at: string; visibility: string; independent: boolean; industry: string; industry_label: string | null; coverage: { total: number; strong: number; thin: number; missing: number } | null; checked_at: string | null; refreshing: boolean; has_updates: boolean; status: string; mode: string };
const mine = async (token: string) => (await get(token, '/me/courses')).json().courses as Mine[];

ct('each list shows its status, who can see it, its industry, when it was started and last used, and a mini coverage count', async () => {
  const a = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 4, roleName: 'business analyst' });
  await h.pool.query(`UPDATE courses SET industry = 'fintech', last_checked_at = '2026-10-09T08:00:00.000Z' WHERE id = $1`, [c.courseId]);
  await enrol(await idOf('alice'), c.courseId, '2026-10-09T10:00:00.000Z');
  const [l] = await mine(a.token);
  assert.deepEqual([l!.id, l!.status, l!.mode, l!.visibility, l!.independent], [c.courseId, 'ready', 'list', 'shared', false]);
  assert.deepEqual([l!.industry, l!.industry_label], ['fintech', 'Fintech']);
  assert.deepEqual([l!.created_at, l!.last_active_at, l!.checked_at, l!.refreshing, l!.custom_title], ['2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z', '2026-10-09T08:00:00.000Z', false, null]);
  assert.deepEqual(l!.coverage, { total: 4, strong: 1, thin: 1, missing: 2 });
});

ct('a list that is still being found or built has no coverage yet, and an independent list says so', async () => {
  const a = await h.signIn('alice');
  const started = await post(a.token, '/courses', { role: 'business analyst', mode: 'list', text: 'Business analyst posting. Skills: SQL, Tableau.' });
  const [l] = await mine(a.token);
  assert.deepEqual([l!.id, l!.status, l!.visibility, l!.independent, l!.coverage], [started.json().course_id, 'finding_sources', 'private', true, null]);
});

ct('a list being checked for new coverage says so, until the check has run', async () => {
  const a = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' });
  await enrol(await idOf('alice'), c.courseId, '2026-10-09T10:00:00.000Z');
  await h.pool.query(`INSERT INTO course_runs (course_id, kind, stage, percent, started_at) VALUES ($1, 'refresh', 'queued', 0, now())`, [c.courseId]);
  assert.equal((await mine(a.token))[0]!.refreshing, true);
  await h.pool.query(`UPDATE course_runs SET finished_at = now() WHERE kind = 'refresh'`);
  assert.equal((await mine(a.token))[0]!.refreshing, false);
});

ct('lists are ordered by when the reader last used them, and opening a list puts it first', async () => {
  const a = await h.signIn('alice');
  const [x, y, z] = [await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' }), await publishedListCourse(h.pool, { concepts: 2, roleName: 'product manager' }), await publishedListCourse(h.pool, { concepts: 2, roleName: 'forward-deployed engineer' })];
  const me = await idOf('alice');
  await enrol(me, x.courseId, '2026-10-01T10:00:00.000Z');
  await enrol(me, y.courseId, '2026-10-03T10:00:00.000Z');
  await enrol(me, z.courseId, '2026-10-02T10:00:00.000Z');
  assert.deepEqual((await mine(a.token)).map((l) => l.id), [y.courseId, z.courseId, x.courseId]);
  const res = await post(a.token, `/me/courses/${x.courseId}/open`);
  assert.equal(res.statusCode, 204);
  assert.deepEqual((await mine(a.token)).map((l) => l.id), [x.courseId, y.courseId, z.courseId]);
  assert.equal((await mine(a.token))[0]!.last_active_at, h.clock.now.toISOString());
});

ct('opening a list the reader has not joined is not found, and joins nothing', async () => {
  const a = await h.signIn('alice');
  await h.signIn('bob');
  const c = await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' });
  await enrol(await idOf('bob'), c.courseId, '2026-10-01T10:00:00.000Z');
  const res = await post(a.token, `/me/courses/${c.courseId}/open`);
  assert.equal(res.statusCode, 404);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM course_inputs WHERE account_id = $1`, [await idOf('alice')]))[0].n, 0);
  assert.equal((await post(a.token, '/me/courses/00000000-0000-4000-8000-000000000000/open')).statusCode, 404);
  assert.equal((await post(a.token, '/me/courses/not-an-id/open')).statusCode, 404);
});

ct('a reader can rename a list for themselves (trimmed, up to 80 characters), and clear the name to go back to the default', async () => {
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  const c = await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' });
  await enrol(await idOf('alice'), c.courseId, '2026-10-01T10:00:00.000Z');
  await enrol(await idOf('bob'), c.courseId, '2026-10-01T10:00:00.000Z');
  assert.equal((await patch(a.token, `/me/courses/${c.courseId}`, { title: '  Treasury systems role  ' })).statusCode, 204);
  assert.equal((await mine(a.token))[0]!.custom_title, 'Treasury systems role');
  assert.equal((await mine(b.token))[0]!.custom_title, null, 'the other reader\'s entry for the same shared list is not renamed');
  assert.equal((await h.rows(`SELECT title FROM courses WHERE id = $1`, [c.courseId]))[0].title, (await h.rows(`SELECT title FROM courses WHERE id = $1`, [c.courseId]))[0].title);
  assert.equal((await patch(a.token, `/me/courses/${c.courseId}`, { title: 'x'.repeat(80) })).statusCode, 204);
  assert.equal((await patch(a.token, `/me/courses/${c.courseId}`, { title: null })).statusCode, 204);
  assert.equal((await mine(a.token))[0]!.custom_title, null);
});

ct('a name that makes no sense is refused and the old one stays', async () => {
  const a = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' });
  await enrol(await idOf('alice'), c.courseId, '2026-10-01T10:00:00.000Z');
  await patch(a.token, `/me/courses/${c.courseId}`, { title: 'Keep me' });
  for (const bad of ['', '   ', 'x'.repeat(81), 'line\nbreak', 'bell\u0007', 42, {}, ['a']]) {
    const res = await patch(a.token, `/me/courses/${c.courseId}`, { title: bad });
    assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_title'], JSON.stringify(bad));
  }
  assert.equal((await patch(a.token, `/me/courses/${c.courseId}`, {})).statusCode, 400, 'no title given');
  assert.equal((await mine(a.token))[0]!.custom_title, 'Keep me');
});

ct('only a reader who has the list can rename it: anyone else is told it is not found', async () => {
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  const c = await publishedListCourse(h.pool, { concepts: 2, roleName: 'business analyst' });
  await enrol(await idOf('bob'), c.courseId, '2026-10-01T10:00:00.000Z');
  assert.equal((await patch(a.token, `/me/courses/${c.courseId}`, { title: 'Mine now' })).statusCode, 404);
  assert.equal((await mine(b.token))[0]!.custom_title, null);
  assert.equal((await patch(undefined, `/me/courses/${c.courseId}`, { title: 'x' })).statusCode, 401);
});

ct('deleting a shared list removes it from that reader\'s lists only: the other reader keeps it, and so does the course', async () => {
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  const c = await publishedListCourse(h.pool, { concepts: 3, roleName: 'business analyst' });
  await enrol(await idOf('alice'), c.courseId, '2026-10-01T10:00:00.000Z');
  await enrol(await idOf('bob'), c.courseId, '2026-10-01T10:00:00.000Z');
  assert.equal((await h.call(a.token, 'DELETE', `/me/courses/${c.courseId}`)).statusCode, 204);
  assert.deepEqual((await mine(a.token)).map((l) => l.id), []);
  assert.deepEqual((await mine(b.token)).map((l) => l.id), [c.courseId]);
  assert.equal((await get(b.token, `/courses/${c.courseId}`)).statusCode, 200);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [c.courseId]))[0].n, 1);
});

ct('the role picker lists every list-mode role, and says which can be started: only business analyst for now', async () => {
  const a = await h.signIn('alice');
  const roles = (await get(a.token, '/courses/options')).json().roles as Array<{ name: string; label: string; available: boolean }>;
  assert.deepEqual(roles.map((r) => [r.label, r.available]).sort(), [['Business analyst', true], ['Forward-deployed engineer', false], ['Product manager', false]]);
});
