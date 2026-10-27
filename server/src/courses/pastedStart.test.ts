// Pasted job description, step 1: asking for a course with a pasted description keeps the description, exactly as pasted, with the reader's own record of
// the course. It is the reader's alone: no route returns it, and it goes when they leave the course. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('pastedstart');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
const MARKER = 'ZZ-PRIVATE-MARKER-4471';
const JD = `Business analyst. Responsibilities: gather requirements, run workshops. Skills: SQL, requirements analysis, Tableau. ${MARKER}`;
const input = async (courseId: string) => (await h.rows(`SELECT typed_text, pasted_text FROM course_inputs WHERE course_id = $1`, [courseId]))[0];

ct('a pasted description is kept as pasted, apart from the typed words, and only for a private course', async () => {
  const a = await h.signIn('alice');
  const res = await post(a.token, '/courses', { role: 'business analyst', mode: 'list', text: `  ${JD}  ` });
  assert.equal(res.statusCode, 202);
  const row = await input(res.json().course_id);
  assert.equal(row.pasted_text, JD, 'trimmed, otherwise exactly as pasted');
  assert.match(row.typed_text, /^business analyst\n/);
  assert.equal((await h.rows(`SELECT visibility FROM courses WHERE id = $1`, [res.json().course_id]))[0].visibility, 'private');
  const plain = await post(a.token, '/courses', { role: 'product manager', mode: 'list' });
  assert.equal((await input(plain.json().course_id)).pasted_text, null, 'nothing pasted, nothing kept');
  const blank = await post(a.token, '/courses', { role: 'forward-deployed engineer', mode: 'list', text: '   \n  ' });
  assert.equal((await input(blank.json().course_id)).pasted_text, null);
  assert.equal((await h.rows(`SELECT visibility FROM courses WHERE id = $1`, [blank.json().course_id]))[0].visibility, 'shared');
});

ct('no route returns the pasted description, to its owner or anyone else', async () => {
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  const id = (await post(a.token, '/courses', { role: 'business analyst', mode: 'list', text: JD })).json().course_id as string;
  for (const url of [`/courses/${id}`, `/courses/${id}/sources`, `/courses/${id}/concepts`, `/courses/${id}/transparency`, `/me/courses`, `/courses/${id}/changes`]) {
    for (const who of [a, b]) {
      const res = await get(who.token, url);
      assert.ok(!res.body.includes(MARKER) && !res.body.includes('Tableau'), `${url} for ${who === a ? 'alice' : 'bob'}`);
    }
  }
});

ct('a description too long for the limit is refused as before and nothing is kept', async () => {
  const a = await h.signIn('alice');
  const res = await post(a.token, '/courses', { role: 'business analyst', mode: 'list', text: 'x'.repeat(4001) });
  assert.deepEqual([res.statusCode, res.json()], [400, { error: 'text_too_long' }]);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs`))[0].count, '0');
});

ct('leaving the course removes the pasted description with it', async () => {
  const a = await h.signIn('alice');
  const id = (await post(a.token, '/courses', { role: 'business analyst', mode: 'list', text: JD })).json().course_id as string;
  assert.equal((await h.call(a.token, 'DELETE', `/me/courses/${id}`)).statusCode, 204);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE pasted_text IS NOT NULL`))[0].count, '0');
  void idOf;
});
