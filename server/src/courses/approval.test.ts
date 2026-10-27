// Plan 16, phase 2, step 6: asking for a course, reviewing the sources, approving, swapping a source and cancelling (spec 16, section 5
// and decisions 23, 28). Finding the sources is the pipeline's job (phase 4); here a request queues that work and tests supply what it found.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../../testkit/harness.ts';
import { enrolReader, pendingCourse, privateCourse, publishedCourse, role, withdrawnCourse } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';
import { createCourseStarts, normalizeRole } from './starts.ts';

const h = useHarness('approval');
const DAY = 86_400_000;

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
const courseRow = async (id: string) => (await h.rows(`SELECT * FROM courses WHERE id = $1`, [id]))[0];
const requestRows = (accountId: string) => h.rows(`SELECT kind, outcome, course_id FROM course_requests WHERE account_id = $1 ORDER BY id`, [accountId]);

// ---- the role a reader types ----------------------------------------------------------------------------------------
import { test } from 'node:test';
test('a role is normalized: lower case, squeezed spaces, trimmed; nothing that is empty, too long or not a name', () => {
  assert.equal(normalizeRole('  Forward-Deployed   Engineer '), 'forward-deployed engineer');
  assert.equal(normalizeRole('Product Manager.'), 'product manager');
  assert.equal(normalizeRole('FP&A Analyst'), 'fp&a analyst');
  for (const bad of ['', '   ', 'x', '12345', '!!!', 'a'.repeat(121), 'https://example.com/jobs', 'line\nbreak', 'bell\u0007']) assert.equal(normalizeRole(bad), null, JSON.stringify(bad));
  assert.equal(normalizeRole('a'.repeat(120)), 'a'.repeat(120));
  assert.equal(normalizeRole(42 as never), null);
});

// ---- asking for a course --------------------------------------------------------------------------------------------
ct('Scenario: asking for a course needs a signed-in account, courses on, and a role', async () => {
  const { alice } = await people();
  assert.equal((await post(undefined, '/courses', { role: 'product manager' })).statusCode, 401);
  const bad = async (payload: unknown, error: string) => {
    const res = await post(alice.token, '/courses', payload);
    assert.deepEqual([res.statusCode, res.json()], [400, { error }], JSON.stringify(payload));
  };
  await bad({}, 'role_required');
  await bad({ role: 5 }, 'role_required');
  await bad({ role: '!!!' }, 'role_invalid');
  await bad({ role: 'product manager', url: 'ftp://x' }, 'url_invalid');
  await bad({ role: 'product manager', url: 'not a url' }, 'url_invalid');
  await bad({ role: 'product manager', text: 'x'.repeat(4001) }, 'text_too_long');
  await bad({ role: 'product manager', text: 7 }, 'text_invalid');
  assert.equal((await h.call(alice.token, 'POST', '/courses', undefined)).statusCode, 400);
  await createCourseSettings(h.pool).set('courses_off', true);
  const off = await post(alice.token, '/courses', { role: 'product manager' });
  assert.deepEqual([off.statusCode, off.json()], [503, { error: 'courses_off' }]);
  assert.equal((await h.rows('SELECT count(*) FROM courses'))[0].count, '0');
});

ct('Scenario: a new request queues finding sources: a pending course, the reader enrolled, a queued run and a logged search', async () => {
  const { alice } = await people();
  const res = await post(alice.token, '/courses', { role: '  Product  Manager ' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers['cache-control'], 'no-store');
  const { course_id, status } = res.json();
  assert.equal(status, 'finding_sources');
  const c = await courseRow(course_id);
  assert.deepEqual([c.visibility, c.owner_account_id, c.requested_by, c.title, c.status], ['shared', null, alice.id, 'product manager', 'finding_sources']);
  assert.equal((await h.rows(`SELECT name FROM roles WHERE id = $1`, [c.role_id]))[0].name, 'product manager');
  const inputs = await h.rows(`SELECT typed_text FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, course_id]);
  assert.equal(inputs[0].typed_text, 'product manager');
  const runs = await h.rows(`SELECT kind, stage, percent, finished_at, requested_by FROM course_runs WHERE course_id = $1`, [course_id]);
  assert.deepEqual(runs, [{ kind: 'source_finding', stage: 'queued', percent: 0, finished_at: null, requested_by: alice.id }]);
  assert.deepEqual(await requestRows(alice.id), [{ kind: 'source_search', outcome: 'started', course_id }]);
});

ct('asking again for the same role while an attempt is pending is the same request and is not counted twice', async () => {
  const { alice } = await people();
  const first = (await post(alice.token, '/courses', { role: 'product manager' })).json();
  const again = await post(alice.token, '/courses', { role: 'Product Manager' });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { course_id: first.course_id, status: 'finding_sources', existing: false });
  assert.equal((await requestRows(alice.id)).length, 1);
  assert.equal((await h.rows('SELECT count(*) FROM courses'))[0].count, '1');
});

ct('a title that is a known alias of a role asks for that role', async () => {
  const { alice } = await people();
  const r = await role(h.pool, 'forward-deployed engineer');
  await h.pool.query(`INSERT INTO role_aliases (role_id, title_seen, last_seen_at) VALUES ($1, 'frontier deployed engineer', now())`, [r]);
  const res = await post(alice.token, '/courses', { role: 'Frontier Deployed Engineer' });
  assert.equal((await courseRow(res.json().course_id)).role_id, r);
  assert.equal((await h.rows('SELECT count(*) FROM roles WHERE name = $1', ['frontier deployed engineer']))[0].count, '0');
});

ct('Scenario: a role that already has a course returns it and enrols the reader, without using the allowance', async () => {
  const { alice, bob } = await people();
  const live = await publishedCourse(h.pool, { roleName: 'data analyst' });
  const res = await post(bob.token, '/courses', { role: 'Data Analyst' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { course_id: live.courseId, status: 'ready', existing: true });
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [bob.id, live.courseId]))[0].count, '1');
  assert.deepEqual(await requestRows(bob.id), [{ kind: 'source_search', outcome: 'served_existing', course_id: live.courseId }]);
  // The same for a course that is still being built.
  await h.pool.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [live.courseId]);
  assert.deepEqual((await post(alice.token, '/courses', { role: 'data analyst' })).json(), { course_id: live.courseId, status: 'building', existing: true });
  // Asking many times never hits the search limit.
  for (let i = 0; i < 8; i++) assert.equal((await post(bob.token, '/courses', { role: 'data analyst' })).statusCode, 200);
});

ct('a role whose course is withdrawn answers course_withdrawn and queues nothing', async () => {
  const { alice } = await people();
  const w = await withdrawnCourse(h.pool, { from: await publishedCourse(h.pool, { roleName: 'compliance officer' }) });
  const res = await post(alice.token, '/courses', { role: 'compliance officer' });
  assert.deepEqual([res.statusCode, res.json()], [409, { error: 'course_withdrawn' }]);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE course_id = $1`, [w.courseId]))[0].count, '0');
  assert.equal((await h.rows('SELECT count(*) FROM course_requests'))[0].count, '0');
});

ct('Scenario: a pasted description makes a private course, even when a shared one exists', async () => {
  const { alice } = await people();
  const live = await publishedCourse(h.pool, { roleName: 'product manager' });
  const res = await post(alice.token, '/courses', { role: 'product manager', text: 'We are hiring a product manager to own our payments roadmap ...' });
  assert.equal(res.statusCode, 202);
  const c = await courseRow(res.json().course_id);
  assert.notEqual(c.id, live.courseId);
  assert.deepEqual([c.visibility, c.owner_account_id, c.requested_by, c.status], ['private', alice.id, alice.id, 'finding_sources']);
  const typed = (await h.rows(`SELECT typed_text FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, c.id]))[0].typed_text as string;
  assert.match(typed, /payments roadmap/);
  assert.equal((await get((await h.signIn('bob')).token, `/courses/${c.id}`)).statusCode, 404, 'nobody else can see it');
});

ct('a link is kept with the request for the pipeline to fetch', async () => {
  const { alice } = await people();
  const res = await post(alice.token, '/courses', { role: 'product manager', url: 'https://jobs.example.com/pm/1' });
  assert.equal(res.statusCode, 202);
  const c = await courseRow(res.json().course_id);
  assert.equal(c.visibility, 'shared', 'a link alone keeps the course shared');
  const typed = (await h.rows(`SELECT typed_text FROM course_inputs WHERE account_id = $1`, [alice.id]))[0].typed_text as string;
  assert.deepEqual(typed.split('\n'), ['product manager', 'https://jobs.example.com/pm/1']);
  const both = await post(alice.token, '/courses', { role: 'data analyst', url: 'https://jobs.example.com/da/1', text: 'pasted words' });
  assert.equal((await courseRow(both.json().course_id)).visibility, 'private', 'a link plus a paste makes a private course');
});

ct('Scenario: the sixth request in a day is refused with the time to try again; the global cap stops everyone', async () => {
  const { alice, bob } = await people();
  for (let i = 0; i < 5; i++) assert.equal((await post(alice.token, '/courses', { role: `role number ${i + 1}` })).statusCode, 202);
  const sixth = await post(alice.token, '/courses', { role: 'role number six' });
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json().error, 'source_search_limit');
  assert.equal(sixth.json().retry_at, new Date(h.clock.now.getTime() + DAY).toISOString());
  await createCourseSettings(h.pool).set('cap.source_searches_per_day', 5);
  const capped = await post(bob.token, '/courses', { role: 'another role' });
  assert.deepEqual([capped.statusCode, capped.json().error], [429, 'source_search_cap']);
});

// ---- reviewing the sources ------------------------------------------------------------------------------------------
ct('Scenario: the requester reviews the matched sources, the near-match left out, and what will be reused', async () => {
  const { alice, bob } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  await h.pool.query(`UPDATE sources SET origin = 'user_url', counts_for_criticality = true WHERE id = $1`, [c.sourceIds[0]]);
  const k1 = (await h.pool.query(`INSERT INTO role_concepts (role_id, name) VALUES ($1, 'sql') RETURNING id`, [c.roleId])).rows[0].id;
  const k2 = (await h.pool.query(`INSERT INTO role_concepts (role_id, name) VALUES ($1, 'roadmapping') RETURNING id`, [c.roleId])).rows[0].id;
  await h.pool.query(`INSERT INTO course_reuse (course_id, from_course_id, concept_id, kind) VALUES ($1, NULL, $2, 'covered'), ($1, NULL, $3, 'new')`, [c.courseId, k1, k2]);

  const res = await get(alice.token, `/courses/${c.courseId}/sources`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'awaiting_approval');
  assert.equal(body.sources.length, 8);
  assert.deepEqual(Object.keys(body.sources[0]).sort(), ['company', 'counts_toward_criticality', 'designation', 'id', 'match', 'origin', 'role_title', 'url']);
  assert.match(body.sources[0].url, /^https:\/\//);
  assert.deepEqual(body.sources.map((s: { origin: string }) => s.origin).sort(), ['Found by Excerp', 'Found by Excerp', 'Found by Excerp', 'Found by Excerp', 'Found by Excerp', 'Found by Excerp', 'Found by Excerp', 'You provided']);
  assert.equal(body.sources.every((s: { counts_toward_criticality: boolean }) => s.counts_toward_criticality), true);
  assert.deepEqual(body.not_used, [{ id: c.notUsedSourceId, company: body.not_used[0].company, role_title: 'Product Marketing Manager', url: body.not_used[0].url, match: 'similar', reason: 'title only resembles the role' }]);
  assert.deepEqual(body.reuse, { covered: 1, related: 0, new: 1, concepts: [{ name: 'sql', kind: 'covered' }, { name: 'roadmapping', kind: 'new' }] });
  assert.deepEqual([body.replace_count, body.replaces_left], [0, 2]);

  assert.equal((await get(bob.token, `/courses/${c.courseId}/sources`)).statusCode, 404, 'only the requester');
  assert.equal((await get(alice.token, `/courses/${(await publishedCourse(h.pool)).courseId}/sources`)).statusCode, 404, 'a course she did not start');
});

ct('a pasted description shows as the reader\'s own source, never counted', async () => {
  const { alice } = await people();
  const c = await privateCourse(h.pool, { ownerId: alice.id });
  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval', published_version = NULL WHERE id = $1`, [c.courseId]);
  const body = (await get(alice.token, `/courses/${c.courseId}/sources`)).json();
  const paste = body.sources.find((s: { id: string }) => s.id === c.pasteSourceId);
  assert.deepEqual([paste.origin, paste.url, paste.counts_toward_criticality, paste.company], ['You provided', null, false, 'Not named']);
});

// ---- approving ------------------------------------------------------------------------------------------------------
ct('Scenario: approving starts generation: the course is building, a version and a queued run exist, and the sources join the evidence', async () => {
  const { alice } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  const res = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { course_id: c.courseId, status: 'building' });
  const course = await courseRow(c.courseId);
  assert.equal(course.status, 'building');
  assert.equal(course.approved_at.toISOString(), h.clock.now.toISOString());
  assert.deepEqual(await h.rows(`SELECT version, status FROM course_versions WHERE course_id = $1`, [c.courseId]), [{ version: 1, status: 'building' }]);
  const run = (await h.rows(`SELECT kind, stage, percent, requested_by, version_id FROM course_runs WHERE course_id = $1 AND kind = 'generation'`, [c.courseId]))[0];
  assert.deepEqual([run.kind, run.stage, run.percent, run.requested_by], ['generation', 'queued', 0, alice.id]);
  assert.ok(run.version_id);
  assert.deepEqual(await h.rows(`SELECT DISTINCT state FROM course_sources WHERE course_id = $1 AND use = 'pool'`, [c.courseId]), [{ state: 'approved' }]);
  assert.equal((await h.rows(`SELECT state FROM course_sources WHERE course_id = $1 AND use = 'not_used'`, [c.courseId]))[0].state, 'proposed');
  assert.deepEqual(await h.rows(`SELECT DISTINCT status FROM sources WHERE id = ANY($1)`, [c.sourceIds]), [{ status: 'current' }]);
  assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'approval' && r.outcome === 'approved').length, 1);
});

ct('approving twice is the same approval: one version, one run, one logged approval', async () => {
  const { alice } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  await post(alice.token, `/courses/${c.courseId}/approve`);
  const again = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.deepEqual([again.statusCode, again.json().status], [200, 'building']);
  assert.equal((await h.rows(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [c.courseId]))[0].count, '1');
  assert.equal((await h.rows(`SELECT count(*) FROM course_runs WHERE course_id = $1 AND kind = 'generation'`, [c.courseId]))[0].count, '1');
  assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'approval').length, 1);
});

ct('only the requester can approve, only while awaiting approval, and only with eight or more postings', async () => {
  const { alice, bob } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  assert.equal((await post(bob.token, `/courses/${c.courseId}/approve`)).statusCode, 404);
  assert.equal((await post(alice.token, `/courses/${(await publishedCourse(h.pool)).courseId}/approve`)).statusCode, 404);
  assert.equal((await post(undefined, `/courses/${c.courseId}/approve`)).statusCode, 401);

  await h.pool.query(`UPDATE courses SET status = 'finding_sources' WHERE id = $1`, [c.courseId]);
  const early = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.deepEqual([early.statusCode, early.json()], [409, { error: 'not_awaiting_approval' }]);
  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1`, [c.courseId]);
  await h.pool.query(`DELETE FROM course_sources WHERE course_id = $1 AND source_id = $2`, [c.courseId, c.sourceIds[0]]);
  const thin = await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.deepEqual([thin.statusCode, thin.json()], [409, { error: 'not_enough_postings' }]);
  assert.equal((await courseRow(c.courseId)).status, 'awaiting_approval');
  assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'approval').length, 0, 'nothing was counted');
});

ct('Scenario: one new course a day: the second approval is refused with the time to try again', async () => {
  const { alice } = await people();
  const [one, two] = [await pendingCourse(h.pool, { requesterId: alice.id }), await pendingCourse(h.pool, { requesterId: alice.id })];
  assert.equal((await post(alice.token, `/courses/${one.courseId}/approve`)).statusCode, 200);
  const second = await post(alice.token, `/courses/${two.courseId}/approve`);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, 'course_limit');
  assert.equal(second.json().retry_at, new Date(h.clock.now.getTime() + DAY).toISOString());
  assert.equal((await courseRow(two.courseId)).status, 'awaiting_approval', 'still waiting, and can be approved tomorrow');
});

ct('Scenario: if another reader\'s course for the role is already building or ready, approving closes this attempt and gives that course', async () => {
  const { alice, bob } = await people();
  const first = await pendingCourse(h.pool, { requesterId: bob.id });
  const second = await pendingCourse(h.pool, { requesterId: alice.id });
  await h.pool.query(`UPDATE courses SET role_id = $1 WHERE id = $2`, [first.roleId, second.courseId]);
  await post(bob.token, `/courses/${first.courseId}/approve`);

  const res = await post(alice.token, `/courses/${second.courseId}/approve`);
  assert.deepEqual([res.statusCode, res.json()], [200, { course_id: first.courseId, status: 'building', existing: true }]);
  const closed = await courseRow(second.courseId);
  assert.deepEqual([closed.status, closed.failure_reason], ['cancelled', 'superseded']);
  assert.equal((await h.rows(`SELECT count(*) FROM course_inputs WHERE account_id = $1 AND course_id = $2`, [alice.id, first.courseId]))[0].count, '1', 'she is enrolled in the shared course');
  assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'approval').length, 0, 'no new course, nothing counted');
});

ct('two readers approving the same role at once: one builds the course, the other is given it', async () => {
  const { alice, bob } = await people();
  const [a, b] = [await pendingCourse(h.pool, { requesterId: alice.id }), await pendingCourse(h.pool, { requesterId: bob.id })];
  await h.pool.query(`UPDATE courses SET role_id = $1 WHERE id = $2`, [a.roleId, b.courseId]);
  const [ra, rb] = await Promise.all([post(alice.token, `/courses/${a.courseId}/approve`), post(bob.token, `/courses/${b.courseId}/approve`)]);
  assert.deepEqual([ra.statusCode, rb.statusCode], [200, 200]);
  assert.equal((await h.rows(`SELECT count(*) FROM courses WHERE role_id = $1 AND status = 'building'`, [a.roleId]))[0].count, '1');
  assert.equal(ra.json().course_id, rb.json().course_id, 'both end up on the same course');
});

// ---- swapping a source ----------------------------------------------------------------------------------------------
ct('Scenario: "not the same role" swaps a source, searches again, and counts as a search; two swaps at most', async () => {
  const { alice } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  const res = await post(alice.token, `/courses/${c.courseId}/sources/${c.sourceIds[0]}/replace`);
  assert.deepEqual([res.statusCode, res.json()], [202, { course_id: c.courseId, status: 'finding_sources' }]);
  const course = await courseRow(c.courseId);
  assert.deepEqual([course.status, course.replace_count], ['finding_sources', 1]);
  assert.equal((await h.rows(`SELECT state FROM course_sources WHERE course_id = $1 AND source_id = $2`, [c.courseId, c.sourceIds[0]]))[0].state, 'replaced');
  assert.equal((await h.rows(`SELECT count(*) FROM course_runs WHERE course_id = $1 AND kind = 'source_finding' AND stage = 'replace'`, [c.courseId]))[0].count, '1');
  assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'source_search' && r.outcome === 'started').length, 2, 'the original search and the swap');

  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1`, [c.courseId]);
  assert.equal((await post(alice.token, `/courses/${c.courseId}/sources/${c.sourceIds[1]}/replace`)).statusCode, 202);
  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1`, [c.courseId]);
  const third = await post(alice.token, `/courses/${c.courseId}/sources/${c.sourceIds[2]}/replace`);
  assert.deepEqual([third.statusCode, third.json()], [409, { error: 'replace_limit' }]);
  assert.equal((await courseRow(c.courseId)).replace_count, 2);
});

ct('a source can be swapped only by the requester, while awaiting approval, and only a found posting', async () => {
  const { alice, bob } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  assert.equal((await post(bob.token, `/courses/${c.courseId}/sources/${c.sourceIds[0]}/replace`)).statusCode, 404);
  assert.equal((await post(alice.token, `/courses/${c.courseId}/sources/00000000-0000-4000-8000-000000000000/replace`)).statusCode, 404);
  assert.equal((await post(alice.token, `/courses/${c.courseId}/sources/nope/replace`)).statusCode, 404);
  const unused = await post(alice.token, `/courses/${c.courseId}/sources/${c.notUsedSourceId}/replace`);
  assert.deepEqual([unused.statusCode, unused.json()], [409, { error: 'cannot_replace' }]);
  await h.pool.query(`UPDATE courses SET status = 'finding_sources' WHERE id = $1`, [c.courseId]);
  const early = await post(alice.token, `/courses/${c.courseId}/sources/${c.sourceIds[0]}/replace`);
  assert.deepEqual([early.statusCode, early.json()], [409, { error: 'not_awaiting_approval' }]);
  assert.equal((await courseRow(c.courseId)).replace_count, 0);
});

ct('a swap is a search, so the daily search limit applies to it', async () => {
  const { alice } = await people();
  await createCourseSettings(h.pool).set('limit.source_searches_per_day', 1);
  const c = await pendingCourse(h.pool, { requesterId: alice.id }); // its own search is already logged
  const res = await post(alice.token, `/courses/${c.courseId}/sources/${c.sourceIds[0]}/replace`);
  assert.deepEqual([res.statusCode, res.json().error], [429, 'source_search_limit']);
  assert.equal((await courseRow(c.courseId)).replace_count, 0);
  assert.equal((await courseRow(c.courseId)).status, 'awaiting_approval');
});

// ---- cancelling and expiry ------------------------------------------------------------------------------------------
ct('cancelling a pending request cancels it, keeps it counted as a search, and is safe to repeat', async () => {
  const { alice } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  const res = await post(alice.token, `/courses/${c.courseId}/cancel`);
  assert.deepEqual([res.statusCode, res.json()], [200, { course_id: c.courseId, status: 'cancelled' }]);
  assert.equal((await courseRow(c.courseId)).status, 'cancelled');
  assert.deepEqual(await requestRows(alice.id), [{ kind: 'source_search', outcome: 'cancelled', course_id: c.courseId }]);
  assert.equal((await post(alice.token, `/courses/${c.courseId}/cancel`)).statusCode, 200);
});

ct('only the requester can cancel; a course being built can now be cancelled too (see cancel.test.ts), and one that is ready or failed cannot', async () => {
  const { alice, bob } = await people();
  const c = await pendingCourse(h.pool, { requesterId: alice.id });
  assert.equal((await post(bob.token, `/courses/${c.courseId}/cancel`)).statusCode, 404);
  await post(alice.token, `/courses/${c.courseId}/approve`);
  assert.equal((await post(bob.token, `/courses/${c.courseId}/cancel`)).statusCode, 404, 'not the requester, whatever the state');
  assert.equal((await courseRow(c.courseId)).status, 'building');
  await h.pool.query(`UPDATE courses SET status = 'failed', failure_reason = 'build_failed' WHERE id = $1`, [c.courseId]);
  const late = await post(alice.token, `/courses/${c.courseId}/cancel`);
  assert.deepEqual([late.statusCode, late.json()], [409, { error: 'not_cancellable' }]);
  assert.equal((await courseRow(c.courseId)).status, 'failed');
});

ct('Scenario: a request not approved within seven days expires, and still counts as a search', async () => {
  const { alice } = await people();
  const [stale, fresh, building, other] = [await pendingCourse(h.pool, { requesterId: alice.id }), await pendingCourse(h.pool, { requesterId: alice.id }), await pendingCourse(h.pool, { requesterId: alice.id }), await publishedCourse(h.pool)];
  await h.pool.query(`UPDATE courses SET status = 'building' WHERE id = $1`, [building.courseId]);
  await h.pool.query(`UPDATE courses SET created_at = $2 WHERE id = ANY($1)`, [[stale.courseId, building.courseId, other.courseId], new Date(h.clock.now.getTime() - 8 * DAY)]);
  await h.pool.query(`UPDATE courses SET created_at = $2 WHERE id = $1`, [fresh.courseId, new Date(h.clock.now.getTime() - 6 * DAY)]);
  const settings = createCourseSettings(h.pool);
  const starts = createCourseStarts(h.pool, settings, () => h.clock.now);
  assert.equal(await starts.expireStale(), 1);
  const gone = await courseRow(stale.courseId);
  assert.deepEqual([gone.status, gone.failure_reason], ['cancelled', 'expired']);
  assert.equal((await courseRow(fresh.courseId)).status, 'awaiting_approval');
  assert.equal((await courseRow(building.courseId)).status, 'building');
  assert.equal((await courseRow(other.courseId)).status, 'ready');
  assert.deepEqual((await requestRows(alice.id)).map((r) => r.outcome).sort(), ['expired', 'started', 'started']);
  void enrolReader;
});

ct('an approval that loses the race at the last step is closed and given the winner\'s course, and is not counted', async () => {
  const { alice } = await people();
  const mine = await pendingCourse(h.pool, { requesterId: alice.id });
  const holder = await h.pool.connect();
  try {
    // Another reader's course for the same role is being claimed in a transaction that has not finished, so this approval cannot see it yet.
    await holder.query('BEGIN');
    const winner = (await holder.query(`INSERT INTO courses (role_id, title, visibility, status) VALUES ($1, 'x', 'shared', 'building') RETURNING id`, [mine.roleId])).rows[0].id as string;
    const pending = post(alice.token, `/courses/${mine.courseId}/approve`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('COMMIT');
    const res = await pending;
    assert.deepEqual([res.statusCode, res.json()], [200, { course_id: winner, status: 'building', existing: true }]);
    assert.deepEqual([(await courseRow(mine.courseId)).status, (await courseRow(mine.courseId)).failure_reason], ['cancelled', 'superseded']);
    assert.equal((await requestRows(alice.id)).filter((r) => r.kind === 'approval' && r.outcome === 'approved').length, 0, 'the approval was not counted');
    assert.equal((await h.rows(`SELECT count(*) FROM course_versions WHERE course_id = $1`, [mine.courseId]))[0].count, '0');
  } finally {
    holder.release();
  }
});
