// Independent lists (business analyst, list mode, pasted posting): every list a reader builds from a posting is its own list. Nothing is merged into an earlier list
// or replaces it, even for the same role and industry, and each list owns its private concepts, so building or deleting one never touches another. Everything else
// (a shared list, a narrative course, product manager and forward-deployed engineer) keeps exactly the rules it had. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness } from '../../testkit/harness.ts';
import { source } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';
import { createSources } from './sources.ts';
import { MULTI_LIST_ROLES, multiListAvailable } from './listMode.ts';

const h = useHarness('independent');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await h.pool.query('TRUNCATE course_settings'); // every test starts from the defaults
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
const posting = (n: number) => `Business analyst posting number ${n}. Responsibilities: gather requirements, run workshops, write user stories. Skills: SQL, Tableau, stakeholder management.`;
const start = (token: string, n: number, extra: Record<string, unknown> = {}) => post(token, '/courses', { role: 'business analyst', mode: 'list', text: posting(n), ...extra });
const row = async (id: string) => (await h.rows(`SELECT status, visibility, independent, industry, mode, role_id FROM courses WHERE id = $1`, [id]))[0];

/** What the finder leaves behind for approval: eight proposed postings, and the course waiting. */
async function readyToApprove(courseId: string) {
  const { role_id: roleId } = await row(courseId);
  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1`, [courseId]);
  for (let i = 0; i < 8; i++) {
    const id = await source(h.pool, roleId, { status: 'proposed' });
    await h.pool.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'pool')`, [courseId, id]);
  }
}

ct('only business analyst lists are independent', async () => {
  assert.deepEqual([...MULTI_LIST_ROLES], ['business-analyst']);
  assert.deepEqual(['business analyst', 'Business Analyst', 'product manager', 'forward-deployed engineer'].map(multiListAvailable), [true, true, false, false]);
});

ct('Scenario: two postings for the same role and industry make two lists; neither replaces or merges into the other', async () => {
  const a = await h.signIn('alice');
  const first = await start(a.token, 1, { industry: 'fintech' });
  const second = await start(a.token, 2, { industry: 'fintech' });
  assert.deepEqual([first.statusCode, second.statusCode], [202, 202]);
  assert.notEqual(first.json().course_id, second.json().course_id);
  for (const r of [first, second]) assert.deepEqual([(await row(r.json().course_id)).visibility, (await row(r.json().course_id)).independent], ['private', true]);
  const mine = (await get(a.token, '/me/courses')).json().courses;
  assert.deepEqual(mine.map((c: { id: string }) => c.id).sort(), [first.json().course_id, second.json().course_id].sort());
});

ct('approving the second list does not cancel it and enrol the reader in the first: both are built', async () => {
  const a = await h.signIn('alice');
  const first = (await start(a.token, 1)).json().course_id as string;
  const second = (await start(a.token, 2)).json().course_id as string;
  await readyToApprove(first);
  await readyToApprove(second);
  assert.equal((await post(a.token, `/courses/${first}/approve`)).statusCode, 200);
  const res = await post(a.token, `/courses/${second}/approve`);
  assert.deepEqual([res.statusCode, res.json().course_id, res.json().status], [200, second, 'building']);
  assert.deepEqual([(await row(first)).status, (await row(second)).status], ['building', 'building']);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM course_versions WHERE status = 'building'`))[0].n, 2);
});

ct('the same posting asked for twice while the first is still waiting is the same attempt (a double tap), not a second list', async () => {
  const a = await h.signIn('alice');
  const first = await start(a.token, 1);
  const again = await start(a.token, 1);
  assert.deepEqual([again.statusCode, again.json().course_id, again.json().existing], [200, first.json().course_id, false]);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM courses`))[0].n, 1);
  const different = await start(a.token, 2);
  assert.notEqual(different.json().course_id, first.json().course_id);
});

ct('no limit applies to approving business analyst lists while the toggle is off: three in a row, the same day', async () => {
  const a = await h.signIn('alice');
  for (const n of [1, 2, 3]) {
    const id = (await start(a.token, n)).json().course_id as string;
    await readyToApprove(id);
    assert.equal((await post(a.token, `/courses/${id}/approve`)).statusCode, 200, `list ${n}`);
  }
});

ct('with the toggle on the old limits apply to business analyst lists again: one approval a day', async () => {
  await createCourseSettings(h.pool).set('limits_on_ba_lists', true);
  const a = await h.signIn('alice');
  const first = (await start(a.token, 1)).json().course_id as string;
  const second = (await start(a.token, 2)).json().course_id as string;
  await readyToApprove(first);
  await readyToApprove(second);
  assert.equal((await post(a.token, `/courses/${first}/approve`)).statusCode, 200);
  const res = await post(a.token, `/courses/${second}/approve`);
  assert.deepEqual([res.statusCode, res.json().error], [429, 'course_limit']);
});

ct('what is not a business analyst list keeps its limits: a second approval the same day is refused', async () => {
  const a = await h.signIn('alice');
  const one = (await post(a.token, '/courses', { role: 'product manager', mode: 'list', text: posting(1) })).json().course_id as string;
  const two = (await post(a.token, '/courses', { role: 'forward-deployed engineer', mode: 'list', text: posting(2) })).json().course_id as string;
  assert.deepEqual([(await row(one)).independent, (await row(two)).independent], [false, false]);
  await readyToApprove(one);
  await readyToApprove(two);
  assert.equal((await post(a.token, `/courses/${one}/approve`)).statusCode, 200);
  assert.equal((await post(a.token, `/courses/${two}/approve`)).json().error, 'course_limit');
});

ct('a product manager list keeps the old rules: a second posting for the same role while the first waits is the same attempt', async () => {
  const a = await h.signIn('alice');
  const first = await post(a.token, '/courses', { role: 'product manager', mode: 'list', text: posting(1) });
  const second = await post(a.token, '/courses', { role: 'product manager', mode: 'list', text: posting(2) });
  assert.equal(second.json().course_id, first.json().course_id);
});

ct('a reader still has five source searches a day, business analyst lists included; the global daily count does not apply to them', async () => {
  const a = await h.signIn('alice');
  for (const n of [1, 2, 3, 4, 5]) assert.equal((await start(a.token, n)).statusCode, 202, `list ${n}`);
  const sixth = await start(a.token, 6);
  assert.deepEqual([sixth.statusCode, sixth.json().error], [429, 'source_search_limit']);

  // the global cap: with 10 searches already today from other readers, a business analyst list is still started and a narrative request is not
  await h.pool.query('TRUNCATE roles CASCADE');
  await createCourseSettings(h.pool).set('cap.source_searches_per_day', 1);
  const b = await h.signIn('bob');
  const c = await h.signIn('carol');
  assert.equal((await post(b.token, '/courses', { role: 'data engineer' })).statusCode, 202); // uses the one search the cap allows
  const ba = await start(c.token, 1);
  assert.equal(ba.statusCode, 202, `a business analyst list is not held by the global count: ${ba.body}`);
  const narrative = await post(c.token, '/courses', { role: 'sales engineer' });
  assert.deepEqual([narrative.statusCode, narrative.json().error], [429, 'source_search_cap']);
});

ct('a shared business analyst list (no posting) is still one list for the role and industry, and asking again reopens it', async () => {
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  const shared = (await post(a.token, '/courses', { role: 'business analyst', mode: 'list', industry: 'fintech' })).json().course_id as string;
  assert.deepEqual([(await row(shared)).visibility, (await row(shared)).independent], ['shared', false]);
  await h.pool.query(`UPDATE courses SET status = 'building', approved_at = now() WHERE id = $1`, [shared]); // claimed: building, ready or withdrawn counts
  const again = await post(b.token, '/courses', { role: 'business analyst', mode: 'list', industry: 'fintech' });
  assert.deepEqual([again.statusCode, again.json().course_id, again.json().existing], [200, shared, true]);
});

// ---- the data-safety fix: each list owns its private concepts ----------------------------------------------------------------------------------------------

async function twoLists() {
  const a = await h.signIn('alice');
  const started = [await start(a.token, 1), await start(a.token, 2)];
  const ids = started.map((r) => r.json().course_id as string);
  assert.deepEqual(started.map((r) => r.statusCode), [202, 202], started.map((r) => r.body).join(' '));
  const owner = (await h.rows(`SELECT owner_account_id FROM courses WHERE id = $1`, [ids[0]]))[0].owner_account_id as string;
  const roleId = (await row(ids[0])).role_id as string;
  return { a, ids, owner, roleId };
}
const privateConcept = (roleId: string, owner: string, courseId: string, name: string, terms: string[]) =>
  h.pool.query(`INSERT INTO role_concepts (role_id, name, kind, terms, mentions, of_postings, visibility, owner_account_id, course_id) VALUES ($1, $2, 'skill', $3::jsonb, 0, 0, 'private', $4, $5) RETURNING id`, [roleId, name, JSON.stringify(terms), owner, courseId]).then((r) => r.rows[0].id as string);

ct('two lists of one reader can each have a private concept with the same name, each with its own terms; the old one-per-name rule still holds for a concept with no list', async () => {
  const { ids, owner, roleId } = await twoLists();
  const k1 = await privateConcept(roleId, owner, ids[0]!, 'reporting, kpis and dashboards', ['power bi']);
  const k2 = await privateConcept(roleId, owner, ids[1]!, 'reporting, kpis and dashboards', ['tableau']);
  assert.notEqual(k1, k2);
  await assert.rejects(privateConcept(roleId, owner, ids[0]!, 'Reporting, KPIs and dashboards', ['x']), /duplicate key/, 'within one list a name is still unique');
  await h.pool.query(`INSERT INTO role_concepts (role_id, name, kind, terms, visibility, owner_account_id) VALUES ($1, 'legacy skill', 'skill', '[]', 'private', $2)`, [roleId, owner]);
  await assert.rejects(h.pool.query(`INSERT INTO role_concepts (role_id, name, kind, terms, visibility, owner_account_id) VALUES ($1, 'Legacy Skill', 'skill', '[]', 'private', $2)`, [roleId, owner]), /duplicate key/);
});

ct('deleting one list removes its concepts and leaves the other list, with its concepts and their terms, exactly as it was', async () => {
  const { a, ids, owner, roleId } = await twoLists();
  const k1 = await privateConcept(roleId, owner, ids[0]!, 'reporting, kpis and dashboards', ['power bi']);
  const k2 = await privateConcept(roleId, owner, ids[1]!, 'reporting, kpis and dashboards', ['tableau']);
  for (const [id, k] of [[ids[0]!, k1], [ids[1]!, k2]] as const) await h.pool.query(`INSERT INTO course_concepts (course_id, concept_id, from_reader_source, position) VALUES ($1, $2, true, 0)`, [id, k]);
  const res = await h.call(a.token, 'DELETE', `/me/courses/${ids[0]}`);
  assert.equal(res.statusCode, 204);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [ids[0]]))[0].n, 0);
  assert.equal((await h.rows(`SELECT count(*)::int AS n FROM role_concepts WHERE id = $1`, [k1]))[0].n, 0, 'its own concept went with it');
  const left = (await h.rows(`SELECT k.terms, cc.course_id FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE k.id = $1`, [k2]))[0];
  assert.deepEqual([left.terms, left.course_id], [['tableau'], ids[1]]);
  assert.equal((await get(a.token, `/courses/${ids[1]}`)).statusCode, 200, 'the other list is still there');
});

ct('the overall credit cap refuses a new list at the door with credit_cap once it is reached (it is off, at 0, unless set)', async () => {
  const a = await h.signIn('alice');
  const settings = createCourseSettings(h.pool);
  const c = (await start(a.token, 1)).json().course_id as string;
  await h.pool.query(`INSERT INTO course_runs (course_id, kind, stage, percent, tavily_credits, started_at, finished_at) VALUES ($1, 'source_finding', 'record', 100, 40, now(), now())`, [c]);
  assert.equal((await start(a.token, 2)).statusCode, 202, 'no cap set, nothing refused');
  await settings.set('cap.credits_total', 40);
  const refused = await start(a.token, 3);
  assert.deepEqual([refused.statusCode, refused.json().error], [429, 'credit_cap']);
});

// ---- thin evidence: the approval gate -------------------------------------------------------------------------------------------------------------------

/** The finder's result for a course waiting for approval: `pool` similar postings, and (when `reader`) the reader's own pasted posting registered as their source. */
async function found(courseId: string, o: { pool: number; reader: boolean }) {
  const { role_id: roleId, owner_account_id: owner } = (await h.rows(`SELECT role_id, owner_account_id FROM courses WHERE id = $1`, [courseId]))[0];
  await h.pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1`, [courseId]);
  for (let i = 0; i < o.pool; i++) {
    const id = await source(h.pool, roleId, { status: 'proposed' });
    await h.pool.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'pool')`, [courseId, id]);
  }
  if (o.reader) {
    const src = createSources(h.pool, () => h.clock.now);
    await src.attach(courseId, await src.registerPaste(roleId, owner, { roleTitle: 'business analyst' }), 'reader');
  }
}

ct('an independent list needs only one usable source to be approved, and its own posting is that source: no similar posting found is fine', async () => {
  const a = await h.signIn('alice');
  const id = (await start(a.token, 1)).json().course_id as string;
  await found(id, { pool: 0, reader: true });
  const res = await post(a.token, `/courses/${id}/approve`);
  assert.deepEqual([res.statusCode, res.json().status], [200, 'building']);
  const other = (await start(a.token, 2)).json().course_id as string;
  await found(other, { pool: 3, reader: true });
  assert.equal((await post(a.token, `/courses/${other}/approve`)).statusCode, 200, 'a few similar postings and its own');
});

ct('an independent list with no source at all is refused with no_source', async () => {
  const a = await h.signIn('alice');
  const id = (await start(a.token, 1)).json().course_id as string;
  await found(id, { pool: 0, reader: false });
  const res = await post(a.token, `/courses/${id}/approve`);
  assert.deepEqual([res.statusCode, res.json().error], [409, 'no_source']);
  assert.equal((await row(id)).status, 'awaiting_approval');
});

ct('a source that was swapped out does not count as one', async () => {
  const a = await h.signIn('alice');
  const id = (await start(a.token, 1)).json().course_id as string;
  await found(id, { pool: 1, reader: false });
  await h.pool.query(`UPDATE course_sources SET state = 'replaced' WHERE course_id = $1`, [id]);
  assert.equal((await post(a.token, `/courses/${id}/approve`)).json().error, 'no_source');
});

ct('everything else keeps its minimum of eight: a private product manager list and a shared business analyst list', async () => {
  const a = await h.signIn('alice');
  const pm = (await post(a.token, '/courses', { role: 'product manager', mode: 'list', text: posting(1) })).json().course_id as string;
  await found(pm, { pool: 7, reader: true });
  const refusedPm = await post(a.token, `/courses/${pm}/approve`);
  assert.deepEqual([refusedPm.statusCode, refusedPm.json().error], [409, 'not_enough_postings']);
  const shared = (await post(a.token, '/courses', { role: 'business analyst', mode: 'list', industry: 'fintech' })).json().course_id as string;
  await found(shared, { pool: 3, reader: false });
  const refusedShared = await post(a.token, `/courses/${shared}/approve`);
  assert.deepEqual([refusedShared.statusCode, refusedShared.json().error], [409, 'not_enough_postings']);
});

