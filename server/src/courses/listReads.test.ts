// List mode, reading a course: the home carries the concepts in order under their display names with their links inline and a rating each, the coverage
// meter counts them, and a link to a library source that has been retired is gone from both. Real API over real SQL.
import assert from 'node:assert/strict';
import { useHarness, USERS } from '../../testkit/harness.ts';
import { publishedCourse, publishedListCourse, source } from '../../testkit/courseFixtures.ts';
import { createCourseSettings } from './settings.ts';

const h = useHarness('listreads');
const ct = (name: string, fn: () => Promise<void>) =>
  h.t(name, async () => {
    await h.pool.query('TRUNCATE roles CASCADE');
    await h.pool.query('TRUNCATE library_sources CASCADE');
    await createCourseSettings(h.pool).set('courses_off', false);
    await fn();
  });
const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
type Concept = { id: string; name: string; display_name: string; position: number; band: string; resources: Array<{ title: string; url: string; kind: string; vetted: boolean }> };

ct('the home of a list course has its concepts in order, each with a display name, a rating and its links inline, and the meter; it has no sections', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 4 });
  const res = await get(token, `/courses/${c.courseId}`);
  assert.equal(res.statusCode, 200);
  const home = res.json();
  assert.equal(home.mode, 'list');
  assert.equal(home.sections, undefined);
  const concepts = home.concepts as Concept[];
  assert.deepEqual(concepts.map((k) => [k.position, k.display_name, k.band]), [[0, 'Display 0', 'strong'], [1, 'Display 1', 'thin'], [2, 'Display 2', 'missing'], [3, 'Display 3', 'missing']]);
  assert.deepEqual(concepts[0]!.resources.map((r) => [r.title, r.kind, r.vetted]), [['Link 0.0', 'article', true], ['Link 0.1', 'blog', false]]);
  assert.deepEqual(concepts[2]!.resources, []);
  assert.ok(concepts.every((k) => k.name && k.id));
  assert.deepEqual(home.coverage, { total: 4, strong: 1, thin: 1, missing: 2, library_backed: 1, with_any_link: 2, library_backed_share: 0.25, any_link_share: 0.5, library_version: null, rated_at: home.coverage.rated_at });
  assert.ok(home.coverage.rated_at);
});

ct('the coverage meter is also its own call, with the rating of each concept and nothing else', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 3 });
  const res = await get(token, `/courses/${c.courseId}/coverage`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.meter, { total: 3, strong: 1, thin: 1, missing: 1, library_backed: 1, with_any_link: 2, library_backed_share: 1 / 3, any_link_share: 2 / 3, library_version: null, rated_at: body.meter.rated_at });
  assert.deepEqual(body.concepts.map((k: { display_name: string; band: string; library_links: number; other_links: number }) => [k.display_name, k.band, k.library_links, k.other_links]), [['Display 0', 'strong', 1, 1], ['Display 1', 'thin', 0, 1], ['Display 2', 'missing', 0, 0]]);
  assert.equal(body.concepts[0].resources, undefined);
});

ct('a library source that has been retired disappears from the links at once, and the ratings read from what is shown', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 3 });
  await h.pool.query(`INSERT INTO library_sources (id, scope, name, url, tier, layer, access, perspective, pipeline_readable, applies_to, status, entry) VALUES ('lib-one','shared','Lib one','https://links.example.org/0/0',1,'institutional','open','canonical',true,'{x}','active','{}')`);
  const before = (await get(token, `/courses/${c.courseId}`)).json();
  assert.equal(before.concepts[0].band, 'strong');
  await h.pool.query(`UPDATE library_sources SET status = 'flagged' WHERE id = 'lib-one'`);
  const after = (await get(token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(after.concepts[0].resources.map((r: { title: string }) => r.title), ['Link 0.1']);
  assert.equal(after.concepts[0].band, 'thin', 'one unvetted link is thin');
  assert.deepEqual([after.coverage.strong, after.coverage.thin, after.coverage.missing, after.coverage.library_backed], [0, 2, 1, 0]);
  const meter = (await get(token, `/courses/${c.courseId}/coverage`)).json().meter;
  assert.deepEqual([meter.strong, meter.thin], [0, 2]);
});

ct('a narrative course home is unchanged, and the coverage call answers not found for it', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedCourse(h.pool);
  const home = (await get(token, `/courses/${c.courseId}`)).json();
  assert.equal(home.mode, 'narrow');
  assert.ok(Array.isArray(home.sections) && home.concepts === undefined && home.coverage === undefined);
  assert.equal((await get(token, `/courses/${c.courseId}/coverage`)).statusCode, 404);
});

const idOf = async (user: 'alice' | 'bob') => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id as string;

ct('a list course that is still being built shows its stage like any other, and has no coverage to read yet', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2 });
  await h.pool.query(`UPDATE courses SET status = 'building', published_version = NULL, requested_by = $2 WHERE id = $1`, [c.courseId, await idOf('alice')]);
  await h.pool.query(`UPDATE course_versions SET status = 'building', published_at = NULL WHERE id = $1`, [c.versionId]);
  await h.pool.query(`UPDATE course_runs SET stage = 'reference', percent = 40 WHERE course_id = $1`, [c.courseId]);
  const home = (await get(token, `/courses/${c.courseId}`)).json();
  assert.deepEqual([home.status, home.mode, home.stage, home.percent, home.concepts], ['building', 'list', 'reference', 40, undefined]);
  assert.equal((await get(token, `/courses/${c.courseId}/coverage`)).statusCode, 404);
});

ct('a private list course is the owner\'s alone, and a signed-out request is refused', async () => {
  const alice = await h.signIn('alice');
  const bob = await h.signIn('bob');
  const c = await publishedListCourse(h.pool, { concepts: 2 });
  await h.pool.query(`UPDATE courses SET visibility = 'private', owner_account_id = $2 WHERE id = $1`, [c.courseId, await idOf('alice')]);
  assert.equal((await get(alice.token, `/courses/${c.courseId}/coverage`)).statusCode, 200);
  assert.equal((await get(bob.token, `/courses/${c.courseId}/coverage`)).statusCode, 404);
  assert.equal((await get(bob.token, `/courses/${c.courseId}`)).statusCode, 404);
  assert.equal((await get(undefined, `/courses/${c.courseId}/coverage`)).statusCode, 401);
});

ct('a concept the reader\'s own pasted description asks for says so, whether or not the market asks for it too; the market badge is hidden only for what only they ask for', async () => {
  const { token } = await h.signIn('alice');
  const alice = await idOf('alice');
  const c = await publishedListCourse(h.pool, { concepts: 3 });
  await h.pool.query(`UPDATE courses SET visibility = 'private', owner_account_id = $2 WHERE id = $1`, [c.courseId, alice]);
  const paste = (await h.rows(`INSERT INTO sources (role_id, role_title, company, url, origin, found_via, match, counts_for_criticality, visibility, owner_account_id, status) VALUES ($1, 'x', 'Not named', NULL, 'user_paste', 'user', 'exact', false, 'private', $2, 'current') RETURNING id`, [c.roleId, alice]))[0].id as string;
  await h.pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'reader', 'approved')`, [c.courseId, paste]);
  // concept 0: market and the posting; concept 1: only the posting; concept 2: only the market
  await h.pool.query(`UPDATE course_concepts SET asked_by = $3::jsonb WHERE course_id = $1 AND concept_id = $2`, [c.courseId, c.conceptIds[0], JSON.stringify([paste, c.sourceIds[0]])]);
  await h.pool.query(`UPDATE course_concepts SET asked_by = $3::jsonb, from_reader_source = true WHERE course_id = $1 AND concept_id = $2`, [c.courseId, c.conceptIds[1], JSON.stringify([paste])]);
  await h.pool.query(`UPDATE course_concepts SET asked_by = $3::jsonb WHERE course_id = $1 AND concept_id = $2`, [c.courseId, c.conceptIds[2], JSON.stringify([c.sourceIds[0]])]);
  type K = { in_your_posting: boolean; from_your_posting: boolean; criticality: string | null };
  const home = (await get(token, `/courses/${c.courseId}`)).json().concepts as K[];
  assert.deepEqual(home.map((k) => k.in_your_posting), [true, true, false]);
  assert.deepEqual(home.map((k) => k.from_your_posting), [false, true, false], 'unchanged: only what only the posting asks for');
  assert.equal(home[0]!.criticality !== null, true, 'a skill the market also asks for keeps its market badge');
  assert.equal(home[1]!.criticality, null);
  const list = (await get(token, `/courses/${c.courseId}/concepts`)).json().concepts as K[];
  assert.deepEqual(list.map((k) => k.in_your_posting), [true, true, false]);
});

ct('a course with no pasted description marks nothing as in the reader\'s posting', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2 });
  const home = (await get(token, `/courses/${c.courseId}`)).json().concepts as Array<{ in_your_posting: boolean }>;
  assert.deepEqual(home.map((k) => k.in_your_posting), [false, false]);
});

ct('a concept that stands for a skill the reader\'s posting named tools for says which tools, as a note', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2 });
  await h.pool.query(`UPDATE course_concepts SET tools = '["Oracle", "Workday"]'::jsonb WHERE course_id = $1 AND concept_id = $2`, [c.courseId, c.conceptIds[0]]);
  const home = (await get(token, `/courses/${c.courseId}`)).json().concepts as Array<{ tools: string[] }>;
  assert.deepEqual(home.map((k) => k.tools), [['Oracle', 'Workday'], []]);
  const list = (await get(token, `/courses/${c.courseId}/concepts`)).json().concepts as Array<{ tools: string[] }>;
  assert.deepEqual(list.map((k) => k.tools), [['Oracle', 'Workday'], []]);
});

ct('the home of a list course says which version this reader has seen the changes up to, so the app can ask for only what is new', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 2 });
  assert.equal((await get(token, `/courses/${c.courseId}`)).json().seen_version, 0);
  const res = await h.call(token, 'POST', `/me/courses/${c.courseId}/seen`, { version: 1 });
  assert.equal(res.statusCode, 204);
  assert.equal((await get(token, `/courses/${c.courseId}`)).json().seen_version, 1);
});

ct('the home of a list course names its industry the way the intake did, so the app need not keep its own list', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 1 });
  await h.pool.query(`UPDATE courses SET industry = 'life-sciences' WHERE id = $1`, [c.courseId]);
  const home = (await get(token, `/courses/${c.courseId}`)).json();
  assert.deepEqual([home.industry, home.industry_label], ['life-sciences', 'Pharma and life sciences']);
  await h.pool.query(`UPDATE courses SET industry = '' WHERE id = $1`, [c.courseId]);
  assert.equal((await get(token, `/courses/${c.courseId}`)).json().industry_label, null);
});

ct('a list built from few postings says so: how many similar postings, whether the reader\'s own was used, and no market badge on any concept', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 4 });
  const normal = (await get(token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(normal.evidence, { thin: false, similar_postings: 9, own_posting: false });
  assert.ok(normal.concepts.some((k: { criticality: string | null }) => k.criticality !== null), 'a list with enough postings shows its badges');

  await h.pool.query(`UPDATE courses SET pool_size = 3, evidence_thin = true WHERE id = $1`, [c.courseId]);
  const paste = await source(h.pool, c.roleId, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: c.requesterId, counts_for_criticality: false, company: 'Not named', status: 'current' });
  await h.pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'reader', 'approved')`, [c.courseId, paste]);
  const thin = (await get(token, `/courses/${c.courseId}`)).json();
  assert.deepEqual(thin.evidence, { thin: true, similar_postings: 3, own_posting: true });
  assert.ok(thin.concepts.every((k: { criticality: string | null }) => k.criticality === null), 'no market badges below eight');
  const concepts = (await get(token, `/courses/${c.courseId}/concepts`)).json().concepts as Array<{ criticality: string | null }>;
  assert.ok(concepts.length > 0 && concepts.every((k) => k.criticality === null));

  await h.pool.query(`UPDATE courses SET pool_size = 0 WHERE id = $1`, [c.courseId]);
  assert.deepEqual((await get(token, `/courses/${c.courseId}`)).json().evidence, { thin: true, similar_postings: 0, own_posting: true });
});


ct('a concept with no explanation (one backed only by a link-only source) is read as an empty explanation: nothing is invented, and the home and the concepts call both answer', async () => {
  const { token } = await h.signIn('alice');
  const c = await publishedListCourse(h.pool, { concepts: 3 });
  await h.pool.query(`UPDATE role_concepts SET plain_explanation = '' WHERE id IN (SELECT concept_id FROM course_concepts WHERE course_id = $1)`, [c.courseId]);
  await h.pool.query(`DELETE FROM concept_claims WHERE concept_id IN (SELECT concept_id FROM course_concepts WHERE course_id = $1)`, [c.courseId]);
  const home = await get(token, `/courses/${c.courseId}`);
  assert.equal(home.statusCode, 200);
  const concepts = home.json().concepts as Array<{ explanation?: string; resources: unknown[] }>;
  assert.equal(concepts.length, 3);
  assert.ok(concepts.every((k) => k.explanation === ''), 'an empty explanation, not a made-up one');
  assert.ok(concepts[0]!.resources.length > 0, 'the links are still there');
  const list = await get(token, `/courses/${c.courseId}/concepts`);
  assert.equal(list.statusCode, 200);
  assert.ok((list.json().concepts as Array<{ explanation?: string }>).every((k) => k.explanation === ''));
});
