// p4Run.ts can pass an industry to a course it builds headlessly. The check is the API's own (the same list of keys), so a key that the API would
// refuse is refused here before anything is queried or any credit is spent. Run with: node --test research/p4Industry.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseInsert, describeIndustry, libraryOption, parseFindArgs } from './p4Industry.ts';
import { INDUSTRIES } from '../src/courses/industries.ts';

test('find takes the role and, optionally, --industry with a key, in either spelling', () => {
  assert.deepEqual(parseFindArgs(['business analyst']), { ok: true, role: 'business analyst', industry: '' });
  assert.deepEqual(parseFindArgs(['business analyst', '--industry', 'fintech']), { ok: true, role: 'business analyst', industry: 'fintech' });
  assert.deepEqual(parseFindArgs(['--industry=healthcare', 'business analyst']), { ok: true, role: 'business analyst', industry: 'healthcare' });
  assert.deepEqual(parseFindArgs(['product manager', '--industry=']), { ok: true, role: 'product manager', industry: '' }); // empty means none, as in the API
});

test('every key the API accepts is accepted, and anything else is industry_invalid', () => {
  for (const i of INDUSTRIES) assert.deepEqual(parseFindArgs(['x analyst', '--industry', i.key]), { ok: true, role: 'x analyst', industry: i.key });
  for (const bad of ['Fintech', ' fintech', 'crypto', 'fin tech', 'none', 'other']) assert.deepEqual(parseFindArgs(['x analyst', '--industry', bad]), { ok: false, error: 'industry_invalid' }, bad);
});

test('a missing role, a flag with no value, an unknown flag or a second role is refused with a reason', () => {
  assert.deepEqual(parseFindArgs([]), { ok: false, error: 'role_required' });
  assert.deepEqual(parseFindArgs(['--industry', 'fintech']), { ok: false, error: 'role_required' });
  assert.deepEqual(parseFindArgs(['x analyst', '--industry']), { ok: false, error: 'industry_invalid' });
  assert.deepEqual(parseFindArgs(['x analyst', '--sector', 'fintech']), { ok: false, error: 'unknown_flag --sector' });
  assert.deepEqual(parseFindArgs(['x analyst', 'y analyst']), { ok: false, error: 'one_role_only' });
});

test('the course row names the industry only when one was chosen, so the script still works on a schema from before industries', () => {
  const none = courseInsert('role-1', 'x analyst', 'acct-1', '');
  assert.ok(!/industry/.test(none.text));
  assert.deepEqual(none.values, ['role-1', 'x analyst', 'acct-1']);
  const some = courseInsert('role-1', 'x analyst', 'acct-1', 'fintech');
  assert.match(some.text, /\(role_id, title, status, requested_by, industry\)/);
  assert.match(some.text, /'finding_sources'/);
  assert.deepEqual(some.values, ['role-1', 'x analyst', 'acct-1', 'fintech']);
});

test('what the script prints says which industry the build will use, and that it will guess when there is none', () => {
  assert.equal(describeIndustry('fintech'), 'industry: fintech (research phrase "fintech and payments software")');
  assert.equal(describeIndustry(''), 'industry: none chosen (the pipeline will guess one)');
  assert.equal(describeIndustry('removed-key'), 'industry: removed-key (not in the current list; the pipeline will guess one)');
});

test('library-first research is off unless P4_LIBRARY=1, and then points at the reference library folder', () => {
  assert.equal(libraryOption({}, '/x/server/research/'), undefined);
  assert.equal(libraryOption({ P4_LIBRARY: '0' }, '/x/server/research/'), undefined);
  assert.equal(libraryOption({ P4_LIBRARY: 'true' }, '/x/server/research/'), undefined); // only the exact 1, like P4_NO_RESEARCH
  assert.deepEqual(libraryOption({ P4_LIBRARY: '1' }, '/x/server/research/'), { dir: '/x/server/research/../reference-library' });
});

