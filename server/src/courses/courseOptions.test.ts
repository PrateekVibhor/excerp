// The app's intake screen asks the server what it may offer: the roles that can have a list course, and the industries. Signed in and approved, like every course route.
import assert from 'node:assert/strict';
import { useHarness } from '../../testkit/harness.ts';
import { createCourseSettings } from './settings.ts';
import { INDUSTRIES } from './industries.ts';
import { LIST_MODE_ROLES, listModeAvailable } from './listMode.ts';

const h = useHarness('courseoptions');

h.t('the options are the list-mode roles and every industry, with names the start route accepts', async () => {
  await createCourseSettings(h.pool).set('courses_off', false);
  const { token } = await h.signIn('alice');
  const res = await h.call(token, 'GET', '/courses/options');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.equal(body.roles.length, LIST_MODE_ROLES.length);
  for (const r of body.roles) assert.ok(listModeAvailable(r.name), r.name);
  assert.deepEqual(body.roles.map((r: { label: string }) => r.label).sort(), ['Business analyst', 'Forward-deployed engineer', 'Product manager']);
  assert.deepEqual(body.industries, INDUSTRIES.map((i) => ({ key: i.key, label: i.label })));
});

h.t('the options need a signed-in account, and answer 503 with courses off', async () => {
  assert.equal((await h.call(undefined, 'GET', '/courses/options')).statusCode, 401);
  const { token } = await h.signIn('alice');
  await createCourseSettings(h.pool).set('courses_off', true);
  const res = await h.call(token, 'GET', '/courses/options');
  assert.deepEqual([res.statusCode, res.json()], [503, { error: 'courses_off' }]);
});
