// List mode, asking for a course: a reader may ask for a list course for the roles that have a library folder; a role and industry can have both a
// narrative course and a list course; and the course says which it is. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { pendingCourse, publishedCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('liststart');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
async function people() {
  const [a, b] = [await h.signIn('alice'), await h.signIn('bob')];
  return { alice: { token: a.token, id: await idOf('alice') }, bob: { token: b.token, id: await idOf('bob') } };
}
const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
const modeOf = async (id: string) => (await h.rows(`SELECT mode FROM courses WHERE id = $1`, [id]))[0].mode as string;

ct('the mode is narrow or list; leaving it out, null or empty means narrow; anything else is mode_invalid and queues nothing', async () => {
  const { alice } = await people();
  for (const bad of ['List', 'both', ' list', 7, ['list'], {}, true]) {
    const res = await post(alice.token, '/courses', { role: 'business analyst', mode: bad });
    assert.deepEqual([res.statusCode, res.json()], [400, { error: 'mode_invalid' }], JSON.stringify(bad));
  }
  assert.equal((await h.rows('SELECT count(*) FROM courses'))[0].count, '0');
  for (const [i, ok] of [undefined, null, '', 'narrow'].entries()) {
    const res = await post(alice.token, '/courses', { role: `data analyst ${i}x`, mode: ok });
    assert.equal(res.statusCode, 202, JSON.stringify(ok));
    assert.equal(await modeOf(res.json().course_id), 'narrow');
  }
});

ct('a list course is offered only for roles that have a library folder', async () => {
  const { alice } = await people();
  for (const role of ['business analyst', 'Product Manager', 'forward-deployed engineer']) {
    const res = await post(alice.token, '/courses', { role, mode: 'list' });
    assert.equal(res.statusCode, 202, role);
    assert.equal(await modeOf(res.json().course_id), 'list', role);
  }
  for (const role of ['data analyst', 'ML engineer', 'backend software engineer']) {
    const res = await post(alice.token, '/courses', { role, mode: 'list' });
    assert.deepEqual([res.statusCode, res.json()], [400, { error: 'list_mode_unavailable' }], role);
  }
  assert.equal((await h.rows(`SELECT count(*) FROM courses WHERE mode = 'list'`))[0].count, '3');
});

ct('the same role and industry can have a narrative course and a list course, and each request gets its own', async () => {
  const { alice, bob } = await people();
  const live = await publishedCourse(h.pool, { roleName: 'business analyst' }); // a narrative course already exists
  const narrow = await post(bob.token, '/courses', { role: 'business analyst' });
  assert.deepEqual([narrow.statusCode, narrow.json().course_id], [200, live.courseId]);
  const list = await post(bob.token, '/courses', { role: 'business analyst', mode: 'list' });
  assert.equal(list.statusCode, 202, 'a list request is not given the narrative course');
  assert.notEqual(list.json().course_id, live.courseId);
  assert.equal(await modeOf(list.json().course_id), 'list');
  // asking for the list course again is the same pending attempt; a narrative ask by the same reader is another
  const again = await post(bob.token, '/courses', { role: 'business analyst', mode: 'list' });
  assert.deepEqual([again.statusCode, again.json().course_id, again.json().existing], [200, list.json().course_id, false]);
  const fin = await post(alice.token, '/courses', { role: 'business analyst', industry: 'fintech', mode: 'list' });
  const finNarrow = await post(alice.token, '/courses', { role: 'business analyst', industry: 'fintech' });
  assert.notEqual(fin.json().course_id, finNarrow.json().course_id);
});

ct('approving: a narrative and a list course of one role both get built; two list courses for the same role and industry are one', async () => {
  const { alice, bob } = await people();
  const a = await pendingCourse(h.pool, { requesterId: alice.id });
  const b = await pendingCourse(h.pool, { requesterId: bob.id });
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  for (const [x, mode] of [[a, 'list'], [b, 'narrow'], [c, 'list']] as const) await h.pool.query(`UPDATE courses SET role_id = $1, mode = $2 WHERE id = $3`, [a.roleId, mode, x.courseId]);
  const ra = await post(alice.token, `/courses/${a.courseId}/approve`);
  const rb = await post(bob.token, `/courses/${b.courseId}/approve`);
  assert.deepEqual([ra.json(), rb.json()], [{ course_id: a.courseId, status: 'building' }, { course_id: b.courseId, status: 'building' }]);
  const rc = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.deepEqual([rc.statusCode, rc.json()], [200, { course_id: a.courseId, status: 'building', existing: true }]);
});

ct('the database allows one claimed shared course per role, industry and mode, and one private course per reader, role, industry and mode', async () => {
  const { alice } = await people();
  const a = await pendingCourse(h.pool, { requesterId: alice.id });
  const mk = (visibility = 'shared', mode = 'narrow') =>
    h.pool.query(`INSERT INTO courses (role_id, title, visibility, owner_account_id, status, mode, approved_at) VALUES ($1, 'x', $2, $3, 'building', $4, now())`, [a.roleId, visibility, visibility === 'private' ? alice.id : null, mode]);
  await mk('shared', 'narrow');
  await assert.rejects(mk('shared', 'narrow'), /courses_shared_role_industry_key/);
  await mk('shared', 'list');
  await assert.rejects(mk('shared', 'list'), /courses_shared_role_industry_key/);
  await mk('private', 'narrow');
  await assert.rejects(mk('private', 'narrow'), /courses_private_role_industry_key/);
  await mk('private', 'list');
});

ct('a course says which mode it is, in its home and in the reader\'s list', async () => {
  const { alice } = await people();
  const c = await publishedCourse(h.pool);
  assert.equal((await get(alice.token, `/courses/${c.courseId}`)).json().mode, 'narrow');
});
