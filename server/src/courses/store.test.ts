import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { NOW, account, chapter, concept, course, next, role, section, source, version } from '../../testkit/courseFixtures.ts';

const { db, url, schema, pool, skipped } = useCourseDb('courses');

/** Asserts that a statement is refused with the given PostgreSQL error code. */
const refused = (statement: Promise<unknown>, sqlstate: '23514' | '23505' | '23503' | '23502') =>
  assert.rejects(statement, (e: { code?: string }) => e.code === sqlstate, `expected SQLSTATE ${sqlstate}`);

const count = async (p: pg.Pool, table: string, where = 'true', args: unknown[] = []) => Number((await p.query(`SELECT count(*) FROM ${table} WHERE ${where}`, args)).rows[0].count);

// ---- the tables -----------------------------------------------------------------------------------------------------
const ACTIVE = [
  'roles', 'role_aliases', 'tracked_companies', 'sources', 'source_skills', 'role_concepts', 'concept_claims', 'resources',
  'courses', 'course_versions', 'course_runs', 'course_sources', 'course_concepts', 'course_reuse', 'course_sections', 'course_chapters',
  'chapter_texts', 'chapter_concepts', 'section_quizzes', 'story_bible', 'claim_excerpts', 'course_inputs', 'course_progress',
  'section_quiz_results', 'course_seen', 'course_requests', 'course_flags', 'course_changes', 'course_settings',
];
const INACTIVE = ['role_snapshots', 'snapshot_skills', 'skill_series', 'role_terms', 'posting_sources'];

db('Scenario: the 29 course tables exist and the inactive ones do not', async (p) => {
  assert.equal(ACTIVE.length, 29);
  const { rows } = await p.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
  const have = new Set(rows.map((r) => r.table_name as string));
  for (const t of ACTIVE) assert.ok(have.has(t), `missing table ${t}`);
  for (const t of INACTIVE) assert.ok(!have.has(t), `${t} must not exist yet`);
});

db('the schema can be applied twice without changing anything', async (p) => {
  const sql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
  await p.query(sql);
  await p.query(sql);
});

// ---- roles, aliases, tracked companies ------------------------------------------------------------------------------
db('a role name is normalized (lower case, trimmed) and unique', async (p) => {
  const name = `product manager ${next()}`;
  await role(p, name);
  await refused(role(p, name), '23505');
  await refused(role(p, ' Mixed Case'), '23514');
  await refused(role(p, ''), '23514');
});

db('an alias is unique per role and cascades with the role', async (p) => {
  const r = await role(p);
  await p.query(`INSERT INTO role_aliases (role_id, title_seen, last_seen_at) VALUES ($1, 'frontier deployed engineer', $2)`, [r, NOW]);
  await refused(p.query(`INSERT INTO role_aliases (role_id, title_seen, last_seen_at) VALUES ($1, 'frontier deployed engineer', $2)`, [r, NOW]), '23505');
  await p.query(`DELETE FROM roles WHERE id = $1`, [r]);
  assert.equal(await count(p, 'role_aliases', 'role_id = $1', [r]), 0);
});

db('a tracked company has a unique domain and a known status and origin', async (p) => {
  const d = `jobs${next()}.example.com`;
  await p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ('Acme', $1, 'seed')`, [d]);
  assert.equal((await p.query(`SELECT status FROM tracked_companies WHERE domain = $1`, [d])).rows[0].status, 'candidate');
  await refused(p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ('Acme again', $1, 'seed')`, [d]), '23505');
  await refused(p.query(`INSERT INTO tracked_companies (employer, domain, added_by, status) VALUES ('X', $1, 'seed', 'great')`, [`x${next()}.example.com`]), '23514');
  await refused(p.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ('X', $1, 'friend')`, [`y${next()}.example.com`]), '23514');
});

// ---- courses --------------------------------------------------------------------------------------------------------
db('one claimed shared course per role; several pending attempts may coexist', async (p) => {
  const r = await role(p);
  const a = await account(p);
  const b = await account(p);
  await course(p, r, { status: 'finding_sources', requested_by: a });
  await course(p, r, { status: 'awaiting_approval', requested_by: b });
  await course(p, r, { status: 'failed', failure_reason: 'qa_failed' });
  await course(p, r, { status: 'cancelled' });
  await course(p, r, { status: 'building' });
  await refused(course(p, r, { status: 'ready', published_version: null }), '23514'); // ready needs a published version, checked below
  await refused(course(p, r, { status: 'building' }), '23505');
  await refused(course(p, r, { status: 'withdrawn', withdrawn_at: NOW }), '23505');
});

db('a private course has an owner and a shared one does not; one live private course per account and role', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  await refused(course(p, r, { visibility: 'private' }), '23514');
  await refused(course(p, r, { visibility: 'shared', owner_account_id: owner }), '23514');
  await course(p, r, { visibility: 'private', owner_account_id: owner, status: 'building' });
  await refused(course(p, r, { visibility: 'private', owner_account_id: owner, status: 'building' }), '23505');
  await course(p, r, { visibility: 'private', owner_account_id: owner, status: 'cancelled' }); // a cancelled attempt does not block
});

db('course status and its companion fields are checked', async (p) => {
  const r = await role(p);
  await refused(course(p, r, { status: 'researching' }), '23514');
  await refused(course(p, r, { status: 'withdrawn' }), '23514'); // withdrawn needs withdrawn_at
  await refused(course(p, r, { replace_count: 3 }), '23514');
  await refused(course(p, r, { replace_count: -1 }), '23514');
  await refused(course(p, r, { visibility: 'secret' }), '23514');
});

db('a published version must belong to the same course, and one version is published per course', async (p) => {
  const r1 = await role(p);
  const r2 = await role(p);
  const c1 = await course(p, r1, { status: 'building' });
  const c2 = await course(p, r2, { status: 'building' });
  const v1 = await version(p, c1, 1, 'published');
  const other = await version(p, c2, 1, 'published');

  await p.query(`UPDATE courses SET published_version = $1, status = 'ready' WHERE id = $2`, [v1, c1]);
  await refused(p.query(`UPDATE courses SET published_version = $1 WHERE id = $2`, [other, c1]), '23503'); // someone else's version

  await refused(version(p, c1, 2, 'published'), '23505'); // a second published version of c1
  await version(p, c1, 2, 'building');
  await refused(version(p, c1, 2, 'building'), '23505'); // version numbers are unique per course
  await refused(p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 3, 'published')`, [c1]), '23514'); // published needs published_at
  await refused(p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 0, 'building')`, [c1]), '23514');
  await refused(p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 4, 'live')`, [c1]), '23514');
});

db('only one version of a course is being built at a time', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  await version(p, c, 1, 'building');
  await refused(version(p, c, 2, 'building'), '23505');
  await version(p, c, 2, 'failed'); // finished or failed versions are not limited
  const other = await course(p, await role(p), { status: 'building' });
  await version(p, other, 1, 'building'); // another course may build at the same time
});

db('publishing swaps the live version in one transaction', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v1 = await version(p, c, 1, 'published');
  await p.query(`UPDATE courses SET published_version = $1, status = 'ready' WHERE id = $2`, [v1, c]);
  const v2 = await version(p, c, 2, 'building');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE course_versions SET status = 'superseded' WHERE id = $1`, [v1]);
    await client.query(`UPDATE course_versions SET status = 'published', published_at = $2 WHERE id = $1`, [v2, NOW]);
    await client.query(`UPDATE courses SET published_version = $1 WHERE id = $2`, [v2, c]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  assert.equal((await p.query(`SELECT published_version FROM courses WHERE id = $1`, [c])).rows[0].published_version, v2);
  assert.equal(await count(p, 'course_versions', `course_id = $1 AND status = 'published'`, [c]), 1);
});

db('a run records a kind, bounded progress and a sensible finish time', async (p) => {
  const r = await role(p);
  const c = await course(p, r);
  const ok = { course: c, kind: 'source_finding', stage: 'find', percent: 10, started: NOW, finished: NOW };
  const insert = (o: Record<string, unknown>) =>
    p.query(`INSERT INTO course_runs (course_id, kind, stage, percent, started_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6)`, [o.course, o.kind, o.stage, o.percent, o.started, o.finished]);
  await insert(ok);
  await refused(insert({ ...ok, kind: 'rebuild' }), '23514');
  await refused(insert({ ...ok, percent: 101 }), '23514');
  await refused(insert({ ...ok, finished: '2026-10-12T11:00:00.000Z' }), '23514');
  assert.equal((await p.query(`SELECT tavily_credits, tokens_in FROM course_runs WHERE course_id = $1`, [c])).rows[0].tavily_credits, 0);
});

// ---- evidence -------------------------------------------------------------------------------------------------------
db('a shared source is unique per role and link; a link may be missing only for a paste', async (p) => {
  const r = await role(p);
  const link = `https://acme.example.com/jobs/unique-${next()}`;
  await source(p, r, { url: link });
  await refused(source(p, r, { url: link }), '23505');
  const other = await role(p);
  await source(p, other, { url: link }); // the same page for another role is a different source row
  await refused(source(p, r, { url: null }), '23514'); // research needs a link
});

db('a pasted description is the only private source, and it never counts toward criticality', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  await source(p, r, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: owner, counts_for_criticality: false });
  await refused(source(p, r, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'shared' }), '23514'); // a paste is private
  await refused(source(p, r, { origin: 'research', visibility: 'private', owner_account_id: owner }), '23514'); // only a paste is private
  await refused(source(p, r, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: owner, counts_for_criticality: true }), '23514');
  await source(p, r, { origin: 'user_url', found_via: 'user', counts_for_criticality: true }); // a fetched link may count
  await refused(source(p, r, { match: 'maybe' }), '23514');
  await refused(source(p, r, { status: 'gone' }), '23514');
  await refused(source(p, r, { found_via: 'guess' }), '23514');
});

db('a source lists its skills once each, and they go with the source or the concept', async (p) => {
  const r = await role(p);
  const s = await source(p, r);
  const c1 = await concept(p, r);
  const c2 = await concept(p, r);
  await p.query(`INSERT INTO source_skills (source_id, concept_id) VALUES ($1, $2), ($1, $3)`, [s, c1, c2]);
  await refused(p.query(`INSERT INTO source_skills (source_id, concept_id) VALUES ($1, $2)`, [s, c1]), '23505');
  await refused(p.query(`INSERT INTO source_skills (source_id, concept_id) VALUES ($1, gen_random_uuid())`, [s]), '23503');
  await p.query(`DELETE FROM role_concepts WHERE id = $1`, [c1]);
  assert.equal(await count(p, 'source_skills', 'source_id = $1', [s]), 1);
  await p.query(`DELETE FROM sources WHERE id = $1`, [s]);
  assert.equal(await count(p, 'source_skills', 'source_id = $1', [s]), 0);
});

db('a concept name is unique per role among shared concepts, criticality is one of three, a private concept has an owner', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  await concept(p, r, 'sql');
  await refused(concept(p, r, 'sql'), '23505');
  await concept(p, r, 'sql', { visibility: 'private', owner_account_id: owner }); // a private concept may share a name
  await refused(concept(p, r, 'python', { visibility: 'private' }), '23514');
  await refused(concept(p, r, 'excel', { criticality: 'critical' }), '23514');
  await concept(p, r, 'roadmapping', { criticality: 'high' });
  await concept(p, r, 'origami'); // criticality may be null
});

db('claims carry one of four categories or none; resources have a kind and a link', async (p) => {
  const r = await role(p);
  const c = await concept(p, r);
  const claim = (category: string | null) => p.query(`INSERT INTO concept_claims (concept_id, claim, category, source_url) VALUES ($1, 'a claim', $2, 'https://example.com')`, [c, category]);
  await claim('law');
  await claim(null);
  await refused(claim('opinion'), '23514');
  const resource = (kind: string) => p.query(`INSERT INTO resources (concept_id, kind, title, url) VALUES ($1, $2, 't', 'https://example.com/r')`, [c, kind]);
  await resource('video');
  await refused(resource('podcast'), '23514');
});

// ---- course content -------------------------------------------------------------------------------------------------
db('a course picks its sources and concepts once each; a not-used source needs a reason', async (p) => {
  const r = await role(p);
  const c = await course(p, r);
  const s = await source(p, r);
  const k = await concept(p, r);
  await p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'pool')`, [c, s]);
  assert.equal((await p.query(`SELECT state FROM course_sources WHERE course_id = $1`, [c])).rows[0].state, 'proposed');
  await refused(p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'pool')`, [c, s]), '23505');
  const s2 = await source(p, r);
  await refused(p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'not_used')`, [c, s2]), '23514');
  await p.query(`INSERT INTO course_sources (course_id, source_id, use, reason) VALUES ($1, $2, 'not_used', 'title differs')`, [c, s2]);
  await refused(p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'sample')`, [c, s]), '23514');
  await p.query(`INSERT INTO course_concepts (course_id, concept_id, position) VALUES ($1, $2, 0)`, [c, k]);
  await refused(p.query(`INSERT INTO course_concepts (course_id, concept_id, position) VALUES ($1, $2, 1)`, [c, k]), '23505');
  await p.query(`INSERT INTO course_reuse (course_id, from_course_id, concept_id, kind) VALUES ($1, NULL, $2, 'new')`, [c, k]);
  await refused(p.query(`INSERT INTO course_reuse (course_id, from_course_id, concept_id, kind) VALUES ($1, NULL, $2, 'same')`, [c, k]), '23514');
});

db('sections and chapters have stable positions; a chapter keeps one text per version and two or three concepts in order', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v1 = await version(p, c, 1, 'published');
  const v2 = await version(p, c, 2, 'building');
  const s = await section(p, c, 0);
  await refused(section(p, c, 0), '23505');
  const ch = await chapter(p, s, v1, 0);
  await refused(chapter(p, s, v1, 0), '23505');
  assert.equal((await p.query(`SELECT status FROM course_chapters WHERE id = $1`, [ch])).rows[0].status, 'live');
  await refused(p.query(`UPDATE course_chapters SET status = 'deleted' WHERE id = $1`, [ch]), '23514');

  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'T', 'body one')`, [ch, v1]);
  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'T', 'body two')`, [ch, v2]);
  await refused(p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'T', 'again')`, [ch, v2]), '23505');

  const k1 = await concept(p, r);
  const k2 = await concept(p, r);
  await p.query(`INSERT INTO chapter_concepts (chapter_id, concept_id, position) VALUES ($1, $2, 0), ($1, $3, 1)`, [ch, k1, k2]);
  await refused(p.query(`INSERT INTO chapter_concepts (chapter_id, concept_id, position) VALUES ($1, $2, 1)`, [ch, await concept(p, r)]), '23505');
});

db('a section quiz and a story bible are kept per version', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v1 = await version(p, c, 1, 'published');
  const v2 = await version(p, c, 2, 'building');
  const s = await section(p, c);
  await p.query(`INSERT INTO section_quizzes (section_id, version_id, questions) VALUES ($1, $2, '[]'::jsonb)`, [s, v1]);
  await p.query(`INSERT INTO section_quizzes (section_id, version_id, questions) VALUES ($1, $2, '[]'::jsonb)`, [s, v2]);
  await refused(p.query(`INSERT INTO section_quizzes (section_id, version_id, questions) VALUES ($1, $2, '[]'::jsonb)`, [s, v2]), '23505');
  await p.query(`INSERT INTO story_bible (course_id, version_id) VALUES ($1, $2)`, [c, v1]);
  await refused(p.query(`INSERT INTO story_bible (course_id, version_id) VALUES ($1, $2)`, [c, v1]), '23505');
});

db('an excerpt is at most 300 characters, has a link, and is only for the four sensitive categories', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v = await version(p, c, 1, 'published');
  const ch = await chapter(p, await section(p, c), v);
  const excerpt = (category: string, text: string, link: string | null = 'https://example.com/p') =>
    p.query(`INSERT INTO claim_excerpts (course_id, chapter_id, version_id, claim, category, excerpt, url) VALUES ($1, $2, $3, 'claim', $4, $5, $6)`, [c, ch, v, category, text, link]);
  await excerpt('money', 'x'.repeat(300));
  await refused(excerpt('money', 'x'.repeat(301)), '23514');
  await refused(excerpt('opinion', 'short'), '23514');
  await refused(excerpt('law', 'short', null), '23502');
});

// ---- readers and their activity -------------------------------------------------------------------------------------
db('a reader has one enrolment row per course, with a capped input; progress, quiz results and seen-version are one row each', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v = await version(p, c, 1, 'published');
  const s = await section(p, c);
  const ch = await chapter(p, s, v);
  const a = await account(p);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'product manager', $3)`, [a, c, NOW]);
  await refused(p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'again', $3)`, [a, c, NOW]), '23505');
  await refused(p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, $3, $4)`, [await account(p), c, 'x'.repeat(4201), NOW]), '23514');

  await p.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3)`, [a, ch, NOW]);
  await refused(p.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3)`, [a, ch, NOW]), '23505');
  await p.query(`INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, 2, 1, $3)`, [a, s, NOW]);
  await refused(p.query(`INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, 3, 2, $3)`, [a, s, NOW]), '23505');
  await refused(p.query(`INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, -1, 1, $3)`, [await account(p), s, NOW]), '23514');
  await p.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1)`, [a, c]);
  await refused(p.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 2)`, [a, c]), '23505');
});

db('the request log takes only known kinds and outcomes', async (p) => {
  const r = await role(p);
  const a = await account(p);
  const log = (kind: string, outcome: string) => p.query(`INSERT INTO course_requests (account_id, role_id, kind, outcome, created_at) VALUES ($1, $2, $3, $4, $5)`, [a, r, kind, outcome, NOW]);
  await log('source_search', 'cancelled');
  await log('approval', 'approved');
  await log('refresh', 'refused');
  await refused(log('login', 'started'), '23514');
  await refused(log('refresh', 'maybe'), '23514');
});

// ---- trust and change -----------------------------------------------------------------------------------------------
db('a reader can flag a target once a day; a handled flag has an action; reasons and targets are known', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v = await version(p, c, 1, 'published');
  const ch = await chapter(p, await section(p, c), v);
  const a = await account(p);
  const flag = (over: Record<string, unknown> = {}) => {
    const f = { reporter: a, type: 'chapter', target: ch, reason: 'inaccurate', status: 'open', action: null, handled: null, created: NOW, ...over };
    return p.query(
      `INSERT INTO course_flags (reporter_id, course_id, version_id, target_type, target_id, reason, snapshot, status, action, handled_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $9, $10)`,
      [f.reporter, c, v, f.type, f.target, f.reason, f.status, f.action, f.handled, f.created],
    );
  };
  await flag();
  await refused(flag({ created: '2026-10-12T20:00:00.000Z' }), '23505'); // same reader, target and day
  await flag({ created: '2026-10-13T08:00:00.000Z' }); // the next day is fine
  await flag({ reporter: await account(p) }); // another reader is fine
  await refused(flag({ reporter: await account(p), reason: 'rude' }), '23514');
  await refused(flag({ reporter: await account(p), type: 'section' }), '23514');
  await refused(flag({ reporter: await account(p), status: 'handled' }), '23514'); // handled needs an action and a time
  await flag({ reporter: await account(p), status: 'handled', action: 'dismissed', handled: NOW });
  await refused(flag({ reporter: await account(p), action: 'ignored', status: 'handled', handled: NOW }), '23514');
});

db('a change belongs to a version and is shown only once published', async (p) => {
  const r = await role(p);
  const c = await course(p, r, { status: 'building' });
  const v = await version(p, c, 1, 'building');
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_added', 'A new chapter')`, [c, v]);
  assert.equal((await p.query(`SELECT published_at FROM course_changes WHERE course_id = $1`, [c])).rows[0].published_at, null);
  await refused(p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'rewrite', 'x')`, [c, v]), '23514');
});

db('settings are a key and a value', async (p) => {
  await p.query(`INSERT INTO course_settings (key, value) VALUES ('courses_off', 'true'::jsonb)`);
  await refused(p.query(`INSERT INTO course_settings (key, value) VALUES ('courses_off', 'false'::jsonb)`), '23505');
  await refused(p.query(`INSERT INTO course_settings (key, value) VALUES ('x', NULL)`), '23502');
});

// ---- indexes --------------------------------------------------------------------------------------------------------
db('the indexes the limits and the refresh job depend on exist', async (p) => {
  const { rows } = await p.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`);
  const defs = rows.map((r) => `${r.indexname} ${r.indexdef}`);
  const has = (table: string, columns: string) => assert.ok(defs.some((d) => d.includes(` ON ${schema}.${table} `) && d.includes(`(${columns})`)), `index on ${table} (${columns})`);
  has('course_requests', 'account_id, kind, created_at');
  has('course_inputs', 'course_id, last_active_at');
  has('sources', 'role_id, status');
  assert.ok(defs.some((d) => d.includes(` ON ${schema}.courses `) && d.includes('(next_check_at)') && /WHERE.*status.*ready/.test(d)), 'index on courses (next_check_at) for ready courses');
  has('source_skills', 'concept_id');
  has('course_flags', 'course_id, target_type, target_id');
});

// ---- deletion -------------------------------------------------------------------------------------------------------
db('deleting a course removes everything that belongs to it', async (p) => {
  const r = await role(p);
  const a = await account(p);
  const c = await course(p, r, { status: 'building' });
  const v = await version(p, c, 1, 'published');
  await p.query(`UPDATE courses SET published_version = $1, status = 'ready' WHERE id = $2`, [v, c]);
  const s = await section(p, c);
  const ch = await chapter(p, s, v);
  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'T', 'b')`, [ch, v]);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'x', $3)`, [a, c, NOW]);
  await p.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3)`, [a, ch, NOW]);
  await p.query(`INSERT INTO course_runs (course_id, version_id, kind, started_at) VALUES ($1, $2, 'generation', $3)`, [c, v, NOW]);
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, summary) VALUES ($1, $2, 'chapter_added', 'x')`, [c, v]);
  await p.query(`DELETE FROM courses WHERE id = $1`, [c]);
  for (const [table, where] of [['course_versions', 'course_id'], ['course_sections', 'course_id'], ['course_inputs', 'course_id'], ['course_runs', 'course_id'], ['course_changes', 'course_id']] as const)
    assert.equal(await count(p, table, `${where} = $1`, [c]), 0, `${table} should be empty`);
  assert.equal(await count(p, 'course_chapters', 'id = $1', [ch]), 0);
  assert.equal(await count(p, 'chapter_texts', 'chapter_id = $1', [ch]), 0);
  assert.equal(await count(p, 'course_progress', 'chapter_id = $1', [ch]), 0);
  assert.equal(await count(p, 'accounts', 'id = $1', [a]), 1, 'the reader stays');
});

db('deleting an account removes its reading activity and private courses, and unlinks what must stay', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  const reader = await account(p);

  const shared = await course(p, r, { status: 'building', requested_by: owner });
  const sv = await version(p, shared, 1, 'published');
  await p.query(`UPDATE courses SET published_version = $1, status = 'ready' WHERE id = $2`, [sv, shared]);
  const ss = await section(p, shared);
  const sch = await chapter(p, ss, sv);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'x', $3)`, [reader, shared, NOW]);
  await p.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3)`, [reader, sch, NOW]);
  await p.query(`INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, 1, 1, $3)`, [reader, ss, NOW]);
  await p.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, 1)`, [reader, shared]);
  await p.query(`INSERT INTO course_requests (account_id, role_id, kind, outcome, created_at) VALUES ($1, $2, 'approval', 'approved', $3)`, [reader, r, NOW]);
  await p.query(`INSERT INTO course_flags (reporter_id, course_id, version_id, target_type, target_id, reason, snapshot, created_at) VALUES ($1, $2, $3, 'chapter', $4, 'outdated', 'frozen text', $5)`, [reader, shared, sv, sch, NOW]);
  await p.query(`INSERT INTO course_runs (course_id, kind, requested_by, started_at) VALUES ($1, 'refresh', $2, $3)`, [shared, reader, NOW]);

  const priv = await course(p, r, { visibility: 'private', owner_account_id: reader, requested_by: reader, status: 'building' });
  const pv = await version(p, priv, 1, 'building');
  await section(p, priv);
  const paste = await source(p, r, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: reader });
  const privateConcept = await concept(p, r, 'only mine', { visibility: 'private', owner_account_id: reader });
  await p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'reader')`, [priv, paste]);

  await p.query(`DELETE FROM accounts WHERE id = $1`, [reader]);

  for (const table of ['course_inputs', 'course_progress', 'section_quiz_results', 'course_seen', 'course_requests'])
    assert.equal(await count(p, table, 'account_id = $1', [reader]) + (table === 'course_progress' ? 0 : 0), 0, `${table} removed`);
  assert.equal(await count(p, 'courses', 'id = $1', [priv]), 0, 'private course removed');
  assert.equal(await count(p, 'course_versions', 'id = $1', [pv]), 0);
  assert.equal(await count(p, 'sources', 'id = $1', [paste]), 0, 'private source removed');
  assert.equal(await count(p, 'role_concepts', 'id = $1', [privateConcept]), 0, 'private concept removed');
  assert.equal(await count(p, 'courses', 'id = $1', [shared]), 1, 'the shared course stays');
  assert.equal((await p.query(`SELECT reporter_id, snapshot FROM course_flags WHERE course_id = $1`, [shared])).rows[0].reporter_id, null, 'the flag stays, unlinked');
  assert.equal((await p.query(`SELECT snapshot FROM course_flags WHERE course_id = $1`, [shared])).rows[0].snapshot, 'frozen text');
  assert.equal((await p.query(`SELECT requested_by FROM course_runs WHERE course_id = $1`, [shared])).rows[0].requested_by, null, 'the run stays, unlinked');
  await p.query(`DELETE FROM accounts WHERE id = $1`, [owner]);
  assert.equal((await p.query(`SELECT requested_by FROM courses WHERE id = $1`, [shared])).rows[0].requested_by, null, 'the shared course outlives its requester');
});

// ---- the migration --------------------------------------------------------------------------------------------------
test('Migrations 009 to 022 - bring a database up to date, can run twice, and ends up with the same tables, columns and indexes as schema.sql', async (t) => {
  if (skipped()) return t.skip(skipped() as string);
  const admin = new pg.Pool({ connectionString: url });
  const migrated = `${schema}_m`;
  try {
    await admin.query(`CREATE SCHEMA ${migrated}`);
    const m = new pg.Pool({ connectionString: url, options: `-c search_path=${migrated}` });
    try {
      const full = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
      await m.query(full.slice(0, full.indexOf('-- Plan 16'))); // a database as it is before this plan
      assert.equal(await count(m, 'information_schema.tables', `table_schema = '${migrated}' AND table_name = 'courses'`), 0);
      const migration = readFileSync(new URL('../../migrations/009_courses.sql', import.meta.url), 'utf8');
      const scenarios = readFileSync(new URL('../../migrations/010_course_scenarios.sql', import.meta.url), 'utf8');
      const industry = readFileSync(new URL('../../migrations/011_course_industry.sql', import.meta.url), 'utf8');
      const libraryUse = readFileSync(new URL('../../migrations/012_library_use.sql', import.meta.url), 'utf8');
      const libraryDb = readFileSync(new URL('../../migrations/013_library_db.sql', import.meta.url), 'utf8');
      const libraryGaps = readFileSync(new URL('../../migrations/014_library_gaps.sql', import.meta.url), 'utf8');
      const listMode = readFileSync(new URL('../../migrations/015_list_mode.sql', import.meta.url), 'utf8');
      const listNotes = readFileSync(new URL('../../migrations/016_list_notifications.sql', import.meta.url), 'utf8');
      const pasted = readFileSync(new URL('../../migrations/017_pasted_description.sql', import.meta.url), 'utf8');
      const tools = readFileSync(new URL('../../migrations/018_concept_tools.sql', import.meta.url), 'utf8');
      const unplacedSql = readFileSync(new URL('../../migrations/019_taxonomy_unplaced.sql', import.meta.url), 'utf8');
      const independent = readFileSync(new URL('../../migrations/020_independent_lists.sql', import.meta.url), 'utf8');
      const judgments = readFileSync(new URL('../../migrations/021_link_judgments.sql', import.meta.url), 'utf8');
      const apple = readFileSync(new URL('../../migrations/022_apple_sign_in.sql', import.meta.url), 'utf8');
      await m.query(migration);
      await m.query(scenarios);
      await m.query(industry);
      await m.query(libraryUse);
      await m.query(libraryDb);
      await m.query(libraryGaps);
      await m.query(listMode);
      await m.query(listNotes);
      await m.query(pasted);
      await m.query(tools);
      await m.query(unplacedSql);
      await m.query(independent);
      await m.query(judgments);
      await m.query(apple);
      await m.query(migration); // running them again changes nothing
      await m.query(scenarios);
      await m.query(industry);
      await m.query(libraryUse);
      await m.query(libraryDb);
      await m.query(libraryGaps);
      await m.query(listMode);
      await m.query(listNotes);
      await m.query(pasted);
      await m.query(tools);
      await m.query(unplacedSql);
      await m.query(independent);
      await m.query(judgments);
      await m.query(apple);

      const shape = async (p: pg.Pool, name: string) => {
        const cols = await p.query(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1, 2`, [name]);
        const idx = await p.query(`SELECT indexname, replace(indexdef, $1, '') AS def FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [name]);
        const cons = await p.query(`SELECT c.conname, replace(pg_get_constraintdef(c.oid), $1, '') AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 ORDER BY 1`, [name]);
        return { cols: cols.rows, idx: idx.rows.map((r) => ({ ...r, def: String(r.def).replace(`${name}.`, '') })), cons: cons.rows };
      };
      const [a, b] = [await shape(pool(), schema), await shape(m, migrated)];
      assert.ok(a.cols.length > 200 && a.idx.length > 30 && a.cons.length > 100, 'the comparison is not empty');
      assert.deepEqual(b.cols, a.cols);
      assert.deepEqual(b.idx, a.idx);
      assert.deepEqual(b.cons, a.cons);
    } finally {
      await m.end();
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${migrated} CASCADE`);
    await admin.end();
  }
});

db('a concept is a skill by default; a scenario is allowed; any other kind is refused (migration 010)', async (p) => {
  const r = await role(p);
  const skill = await concept(p, r, 'python');
  assert.equal((await p.query(`SELECT kind FROM role_concepts WHERE id = $1`, [skill])).rows[0].kind, 'skill');
  await p.query(`INSERT INTO role_concepts (role_id, name, kind) VALUES ($1, 'diagnose a production incident', 'scenario')`, [r]);
  await refused(p.query(`INSERT INTO role_concepts (role_id, name, kind) VALUES ($1, 'something', 'story')`, [r]), '23514');
  await refused(p.query(`INSERT INTO role_concepts (role_id, name, kind) VALUES ($1, 'Python', 'scenario')`, [r]), '23505'); // one name per role, whatever the kind
});
