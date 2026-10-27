// Plan 16, part 3, step C in the build: library-first research behind a flag. Off, nothing changes. On, a concept the library covers is grounded from it
// (no search, no judge, no industry guess), one it does not cover is researched live as before, and every library fact keeps the source it came from.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';
import { importLibrary, loadLibraryFromDb } from '../library/db.ts';

const { db } = useCourseDb('librarybuild', { reset: ['roles', 'accounts'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const SENTINEL = 'ZZ-LONG-SOURCE-TEXT-THAT-MUST-NOT-BE-STORED';
const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);

const ent = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'institutional', tier: 1, access: 'open', perspective: 'canonical', pipeline_readable: true,
  applies_to: ['backend-engineer'], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
});
/** A library with one role folder ('backend-engineer', the role the tests build) and the sources given. */
function library(sources: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lib-build-'));
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ note: '', sources: [] }));
  mkdirSync(join(dir, 'backend-engineer'));
  writeFileSync(join(dir, 'backend-engineer', 'sources.json'), JSON.stringify({ role: 'backend-engineer', built: '2026-10-16', rules: '', sources, uses_shared: [], checked_and_excluded: [] }));
  return dir;
}
/** What the library's pages say: the sql page defines sql and says more; nothing mentions caching. */
const PAGES: Record<string, string> = {
  'https://src-a.example.org/doc': `${filler(20)}Debugging is the process of finding and fixing the cause of a fault. Debugging is done by reproducing the failure first. ${SENTINEL} ${filler(20)}`,
  'https://src-b.example.org/doc': `${filler(20)}Debugging is made easier when a team keeps good logs of its running systems. ${filler(20)}`,
  'https://src-c.example.org/doc': `${filler(20)}A relational database is queried with a language called sql in most systems. Sql is used to read and change tables of data. ${filler(20)}`,
};
const fetcher = (calls: string[] = []) => async (url: string) => (calls.push(url), PAGES[url] ? new Response(PAGES[url], { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 }));

async function approved(p: pg.Pool, n = 9) {
  const roleId = await role(p, 'backend engineer', 'Builds and runs services.');
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'backend engineer' });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { roleId, courseId, versionId, urls };
}
const SKILLS = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
const texts = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, postingText(SKILLS(i), [])]));

function deps(p: pg.Pool, urls: string[], extra: Record<string, unknown> = {}, modelOpts: Parameters<typeof fakeModel>[0] = {}) {
  const queries: string[] = [];
  const search = fakeSearch();
  const inner = search.search.bind(search);
  search.search = async (q) => (queries.push(q.query), inner(q));
  const chat = fakeModel(modelOpts);
  return { queries, chat, search, d: { pool: p, chat, search, extract: fakeExtract(texts(urls)), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW, ...extra } };
}

db('with the flag off the library is never read and the model is never asked to match', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls, {}, { libraryMatches: { debugging: ['src-a'] } });
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  assert.ok(!x.chat.labels.includes('libmatch'));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_use`)).rows[0].n, 0);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM concept_claims WHERE library_source_id IS NOT NULL`)).rows[0].n, 0);
});

db('with the flag on, covered concepts are grounded from the library with no search, and the rest are researched live', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b'), ent('src-c')]);
  try {
    const fetched: string[] = [];
    const x = deps(p, c.urls, { library: { dir, fetcher: fetcher(fetched), minFacts: 2 } }, { libraryMatches: { debugging: ['src-a', 'src-b'], sql: ['src-c'], caching: ['src-c'] } });
    const r = await buildCourse(x.d, c.courseId);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(x.chat.labels.includes('libmatch'));

    const use = (await p.query(`SELECT k.name, u.outcome, u.facts, u.source_ids FROM library_use u JOIN role_concepts k ON k.id = u.concept_id WHERE u.course_id = $1 ORDER BY k.name`, [c.courseId])).rows;
    const by = Object.fromEntries(use.map((u) => [u.name, u]));
    assert.equal(by['debugging'].outcome, 'library');
    assert.ok(by['debugging'].facts >= 2);
    assert.deepEqual([...by['debugging'].source_ids].sort(), ['src-a', 'src-b']);
    assert.equal(by['sql'].outcome, 'library');
    assert.equal(by['caching'].outcome, 'live', 'nothing in the library says anything about caching');

    // no search was made for the concepts the library covered
    const research = x.queries.filter((q) => / for a backend engineer: | backend engineer .* definition standard reference/.test(q));
    assert.ok(research.length > 0 && research.every((q) => /^caching/.test(q)), x.queries.join(' | '));
    // each library fact keeps its source; live facts have none
    const claims = (await p.query(`SELECT k.name, c.library_source_id, c.source_url FROM concept_claims c JOIN role_concepts k ON k.id = c.concept_id WHERE k.role_id = $1`, [c.roleId])).rows;
    assert.ok(claims.filter((x) => x.name === 'debugging').every((x) => x.library_source_id && x.source_url?.includes('example.org')));
    assert.ok(claims.filter((x) => x.name === 'caching').every((x) => x.library_source_id === null));
    // the go-deeper resources of a covered concept are the library's own pages
    const res = (await p.query(`SELECT r.url FROM resources r JOIN role_concepts k ON k.id = r.concept_id WHERE k.name = 'debugging' AND k.role_id = $1`, [c.roleId])).rows.map((x) => x.url);
    assert.ok(res.includes('https://src-a.example.org/doc'));
    // the source text itself is never stored
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM concept_claims WHERE claim LIKE $1`, [`%${SENTINEL}%`])).rows[0].n, 0);
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM resources WHERE why LIKE $1 OR title LIKE $1`, [`%${SENTINEL}%`])).rows[0].n, 0);
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_use WHERE source_ids::text LIKE $1`, [`%${SENTINEL}%`])).rows[0].n, 0);
    // a source is fetched once for the whole build, however many concepts use it
    assert.equal(fetched.filter((u) => u === 'https://src-c.example.org/doc').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a concept the library covers but leaves under two resources is topped up by one live search for resources only', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b'), ent('src-c')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher: fetcher(), minFacts: 2 } }, { libraryMatches: { debugging: ['src-a', 'src-b'], sql: ['src-c'], caching: ['src-c'] } });
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    const use = (await p.query(`SELECT k.name, u.outcome FROM library_use u JOIN role_concepts k ON k.id = u.concept_id WHERE u.course_id = $1`, [c.courseId])).rows;
    assert.equal(use.find((u) => u.name === 'sql')?.outcome, 'library');
    const topUps = x.queries.filter((q) => /^sql /.test(q));
    assert.equal(topUps.length, 1, x.queries.join(' | '));
    assert.ok(!x.queries.some((q) => /^debugging /.test(q)), 'debugging has two library pages: no top-up');
    const res = async (name: string) => (await p.query(`SELECT r.url FROM resources r JOIN role_concepts k ON k.id = r.concept_id WHERE k.name = $1 AND k.role_id = $2`, [name, c.roleId])).rows.map((r) => r.url as string);
    const sql = await res('sql');
    assert.ok(sql.length >= 2 && sql[0] === 'https://src-c.example.org/doc', sql.join(' '));
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM concept_claims c JOIN role_concepts k ON k.id = c.concept_id WHERE k.name = 'sql' AND c.library_source_id IS NULL`)).rows[0].n, 0, 'no facts come from the top-up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('the library can be read from the database instead of the files, and then the build grounds from it the same way', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b'), ent('src-c')]);
  try {
    await importLibrary(p, dir, ['backend-engineer']);
    rmSync(dir, { recursive: true, force: true }); // from here on only the database holds the library
    const x = deps(p, c.urls, { library: { load: () => loadLibraryFromDb(p), fetcher: fetcher(), minFacts: 2 } }, { libraryMatches: { debugging: ['src-a', 'src-b'], sql: ['src-c'], caching: ['src-c'] } });
    const r = await buildCourse(x.d, c.courseId);
    assert.equal(r.ok, true, JSON.stringify(r));
    const outcomes = Object.fromEntries((await p.query(`SELECT k.name, u.outcome FROM library_use u JOIN role_concepts k ON k.id = u.concept_id WHERE u.course_id = $1`, [c.courseId])).rows.map((u) => [u.name, u.outcome]));
    assert.equal(outcomes['debugging'], 'library');
    assert.equal(outcomes['sql'], 'library');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a concept the library covers is not asked about its industry; a chosen industry is still the hint for the facts', async (p) => {
  const c = await approved(p);
  await p.query(`UPDATE courses SET industry = 'fintech' WHERE id = $1`, [c.courseId]);
  const dir = library([ent('src-a'), ent('src-b'), ent('src-c')]);
  try {
    const prompts: string[] = [];
    const x = deps(p, c.urls, { library: { dir, fetcher: fetcher(), minFacts: 2 } }, { libraryMatches: { debugging: ['src-a', 'src-b'], sql: ['src-c'] }, override: (_l, m) => (prompts.push(m.map((y) => y.content).join('\n')), undefined) });
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.ok(prompts.some((q) => q.includes('The course is about fintech and payments software.') && /List the facts about one skill/.test(q) && q.includes('Debugging is the process')));
    assert.equal((await p.query(`SELECT DISTINCT industry FROM concept_claims c JOIN role_concepts k ON k.id = c.concept_id WHERE k.name = 'debugging'`)).rows[0].industry, 'fintech');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a free-account source is never fetched, a fetch that fails sends the concept to live research, and a thin match is not enough', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-gone', { url: 'https://src-gone.example.org/doc' }), ent('src-acct', { access: 'free_account', pipeline_readable: false, url: 'https://src-acct.example.org/doc' })]);
  try {
    const fetched: string[] = [];
    const x = deps(p, c.urls, { library: { dir, fetcher: fetcher(fetched), minFacts: 3 } }, { libraryMatches: { debugging: ['src-acct', 'src-gone', 'src-a'], sql: ['src-gone'] } });
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.ok(!fetched.includes('https://src-acct.example.org/doc'));
    const outcomes = Object.fromEntries((await p.query(`SELECT k.name, u.outcome FROM library_use u JOIN role_concepts k ON k.id = u.concept_id`)).rows.map((r) => [r.name, r.outcome]));
    assert.equal(outcomes['debugging'], 'live', 'src-a alone gave fewer than three verified facts');
    assert.equal(outcomes['sql'], 'live');
    assert.ok(x.queries.some((q) => q.startsWith('debugging')) && x.queries.some((q) => q.startsWith('sql')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a role with no library folder is researched live as before, with no matching call', async (p) => {
  const c = await approved(p);
  await p.query(`UPDATE roles SET name = 'a role the library lacks' WHERE id = $1`, [c.roleId]);
  const dir = library([ent('src-a')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher: fetcher(), minFacts: 2 } }, { libraryMatches: { debugging: ['src-a'] } });
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.ok(!x.chat.labels.includes('libmatch'));
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_use`)).rows[0].n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
