// Plan 16, part 3, step A: the industry a reader may pick when asking for a course. Courses are split per role and industry (a business analyst
// course for fintech is a different course from one for healthcare, and from one with no industry chosen). Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { pendingCourse, publishedCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('industry');
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
const industryOf = async (id: string) => (await h.rows(`SELECT industry FROM courses WHERE id = $1`, [id]))[0].industry as string;

ct('an industry must be one of the listed keys; leaving it out, null or empty means none was chosen', async () => {
  const { alice } = await people();
  for (const bad of ['Fintech', 'crypto', ' fintech', 7, ['fintech'], {}, true]) {
    const res = await post(alice.token, '/courses', { role: 'business analyst', industry: bad });
    assert.deepEqual([res.statusCode, res.json()], [400, { error: 'industry_invalid' }], JSON.stringify(bad));
  }
  assert.equal((await h.rows('SELECT count(*) FROM courses'))[0].count, '0', 'nothing was queued');
  for (const [i, ok] of [undefined, null, ''].entries()) {
    const res = await post(alice.token, '/courses', { role: `analyst ${i}x`, industry: ok });
    assert.equal(res.statusCode, 202, JSON.stringify(ok));
    assert.equal(await industryOf(res.json().course_id), '', JSON.stringify(ok));
  }
});

ct('the industry chosen is kept on the course the request queues', async () => {
  const { alice } = await people();
  const res = await post(alice.token, '/courses', { role: 'business analyst', industry: 'fintech' });
  assert.equal(res.statusCode, 202);
  assert.equal(await industryOf(res.json().course_id), 'fintech');
});

ct('the same role for two industries is two courses, and one with no industry is a third', async () => {
  const { alice } = await people();
  const ids = new Set<string>();
  for (const industry of ['fintech', 'healthcare', undefined]) {
    const res = await post(alice.token, '/courses', { role: 'business analyst', industry });
    assert.equal(res.statusCode, 202, String(industry)); // each is a new search, not the pending attempt of another industry
    ids.add(res.json().course_id);
  }
  assert.equal(ids.size, 3);
  // Asking again for the same role and industry is the same pending attempt, not a new search.
  const again = await post(alice.token, '/courses', { role: 'business analyst', industry: 'healthcare' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().existing, false);
  assert.equal(await industryOf(again.json().course_id), 'healthcare');
});

ct('a course that exists is returned only to a request for the same industry', async () => {
  const { bob } = await people();
  const live = await publishedCourse(h.pool, { roleName: 'data analyst' }); // no industry: the courses built before industries existed
  const served = await post(bob.token, '/courses', { role: 'data analyst' });
  assert.deepEqual([served.statusCode, served.json()], [200, { course_id: live.courseId, status: 'ready', existing: true }]);
  const other = await post(bob.token, '/courses', { role: 'data analyst', industry: 'fintech' });
  assert.equal(other.statusCode, 202, 'a fintech request is not given the course with no industry');
  assert.notEqual(other.json().course_id, live.courseId);
  await h.pool.query(`UPDATE courses SET industry = 'fintech' WHERE id = $1`, [live.courseId]);
  assert.equal((await post(bob.token, '/courses', { role: 'data analyst', industry: 'fintech' })).json().course_id, live.courseId);
  assert.equal((await post(bob.token, '/courses', { role: 'data analyst', industry: 'healthcare' })).statusCode, 202);
});

ct('approving: courses of one role for different industries are all built; two for the same industry are one course', async () => {
  const { alice, bob } = await people();
  const a = await pendingCourse(h.pool, { requesterId: alice.id });
  const b = await pendingCourse(h.pool, { requesterId: bob.id });
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  for (const [x, industry] of [[a, 'fintech'], [b, 'healthcare'], [c, 'fintech']] as const) await h.pool.query(`UPDATE courses SET role_id = $1, industry = $2 WHERE id = $3`, [a.roleId, industry, x.courseId]);
  const ra = await post(alice.token, `/courses/${a.courseId}/approve`);
  const rb = await post(bob.token, `/courses/${b.courseId}/approve`);
  assert.deepEqual([ra.json(), rb.json()], [{ course_id: a.courseId, status: 'building' }, { course_id: b.courseId, status: 'building' }]);
  // alice's second fintech attempt loses to her first and is given it
  const rc = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.deepEqual([rc.statusCode, rc.json()], [200, { course_id: a.courseId, status: 'building', existing: true }]);
  assert.equal((await h.rows(`SELECT count(*) FROM courses WHERE role_id = $1 AND status = 'building'`, [a.roleId]))[0].count, '2');
});

ct('the database allows one claimed shared course per role and industry, and one private course per reader, role and industry', async () => {
  const { alice } = await people();
  const a = await pendingCourse(h.pool, { requesterId: alice.id });
  const mk = (_label: string, visibility = 'shared', industry = '') =>
    h.pool.query(`INSERT INTO courses (role_id, title, visibility, owner_account_id, status, industry, approved_at) VALUES ($1, 'x', $2, $3, 'building', $4, now())`, [a.roleId, visibility, visibility === 'private' ? alice.id : null, industry]);
  await mk('first');
  await assert.rejects(mk('same industry'), /courses_shared_role_industry_key/);
  await mk('another industry', 'shared', 'fintech');
  await assert.rejects(mk('same again', 'shared', 'fintech'), /courses_shared_role_industry_key/);
  await mk('private', 'private');
  await assert.rejects(mk('private twice', 'private'), /courses_private_role_industry_key/);
  await mk('private, other industry', 'private', 'banking');
});

ct('a course shows its industry (null when none was chosen)', async () => {
  const { alice } = await people();
  const plain = await publishedCourse(h.pool);
  const fin = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET industry = 'fintech' WHERE id = $1`, [fin.courseId]);
  assert.equal((await get(alice.token, `/courses/${plain.courseId}`)).json().industry, null);
  assert.equal((await get(alice.token, `/courses/${fin.courseId}`)).json().industry, 'fintech');
});

ct('a concept\'s resources are those of the course\'s industry; without a course, those with no industry', async () => {
  const { alice, bob } = await people();
  const c = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET industry = 'fintech' WHERE id = $1`, [c.courseId]);
  const concept = c.conceptIds[0]!;
  await h.pool.query(`INSERT INTO resources (concept_id, kind, title, url, industry) VALUES ($1, 'article', 'A fintech page', 'https://fin.example.org/a', 'fintech')`, [concept]);
  const titles = async (token: string, query = '') => ((await get(token, `/concepts/${concept}/resources${query}`)).json().resources as Array<{ title: string }>).map((r) => r.title);
  assert.deepEqual(await titles(alice.token, `?course=${c.courseId}`), ['A fintech page']);
  const generic = await titles(alice.token);
  assert.ok(generic.length >= 2 && !generic.includes('A fintech page'));
  // a course id that is unknown, malformed or not visible to the reader changes nothing: the generic list
  const hidden = await publishedCourse(h.pool);
  await h.pool.query(`UPDATE courses SET visibility = 'private', owner_account_id = $2, industry = 'fintech' WHERE id = $1`, [hidden.courseId, bob.id]);
  for (const q of ['?course=nonsense', '?course=00000000-0000-4000-8000-000000000000', `?course=${hidden.courseId}`]) assert.deepEqual(await titles(alice.token, q), generic, q);
});
