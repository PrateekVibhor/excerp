// List mode in the pipeline: the same reading, ranking, comparing, researching and ordering, then a list of concepts with real links and a rating for each,
// and no plan, no written chapters, no coherence pass, no checks and no quiz. Real SQL, fake model and search.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';

const { db } = useCourseDb('listbuild', { reset: ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const ent = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'institutional', tier: 1, access: 'open', perspective: 'canonical', pipeline_readable: true, applies_to: ['backend-engineer'],
  rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
});
function library(sources: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lib-list-'));
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ note: '', sources: [] }));
  mkdirSync(join(dir, 'backend-engineer'));
  writeFileSync(join(dir, 'backend-engineer', 'sources.json'), JSON.stringify({ role: 'backend-engineer', built: '2026-10-16', rules: '', sources, uses_shared: [], checked_and_excluded: [] }));
  return dir;
}
const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);
const PAGES: Record<string, string> = {
  'https://src-a.example.org/doc': `${filler(20)}Debugging is the process of finding and fixing the cause of a fault. Debugging is done by reproducing the failure first. Good debugging starts with a clear report. ${filler(20)}`,
  'https://src-b.example.org/doc': `${filler(20)}Debugging is made easier when a team keeps good logs of its running systems. Debugging tools help. Debugging by logs is common. ${filler(20)}`,
};
const fetcher = async (url: string) => (PAGES[url] ? new Response(PAGES[url], { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 }));

async function approved(p: pg.Pool, mode = 'list') {
  const roleId = await role(p, 'backend engineer', 'Builds and runs services.');
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'backend engineer', mode });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { roleId, courseId, versionId, urls };
}
const SKILLS = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['caching'] : [])];
const texts = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, postingText(SKILLS(i), [])]));
const READ_OK = async () => ({ ok: true as const, text: 'A page that explains the idea in plain words, at some length, for people doing the work. '.repeat(10) });
function deps(p: pg.Pool, urls: string[], extra: Record<string, unknown> = {}, model: ReturnType<typeof fakeModel> = fakeModel()) {
  return { chat: model, d: { pool: p, chat: model, search: fakeSearch(), extract: fakeExtract(texts(urls)), youtube: fakeYoutube(), reachable: async () => true, readPage: READ_OK, now: () => NOW, ...extra } };
}

db('a list course is built without a plan, chapters, coherence pass, checks or quiz, and is published with its concepts in order', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls);
  const r = await buildCourse(x.d, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const label of ['story', 'write', 'coherence', 'openings', 'scope', 'qa', 'quiz', 'verify']) assert.ok(!x.chat.labels.includes(label), `${label} was not asked`);
  assert.ok(x.chat.labels.includes('dispname'), 'the display names were asked for, once');
  assert.equal(x.chat.labels.filter((l) => l === 'dispname').length, 1);
  const course_ = (await p.query(`SELECT status, published_version, mode, pool_size FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([course_.status, course_.mode, course_.published_version === c.versionId], ['ready', 'list', true]);
  for (const t of ['course_sections', 'course_chapters', 'chapter_texts', 'section_quizzes', 'story_bible']) {
    const n = (await p.query(`SELECT count(*)::int AS n FROM ${t} ${t === 'course_chapters' || t === 'chapter_texts' ? '' : 'WHERE true'}`)).rows[0].n;
    assert.equal(n, 0, `${t} is empty`);
  }
  const cc = (await p.query(`SELECT k.name, cc.position FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY cc.position`, [c.courseId])).rows;
  const lc = (await p.query(`SELECT k.name, l.position, l.display_name, l.band FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 ORDER BY l.position`, [c.versionId])).rows;
  assert.deepEqual(lc.map((x) => x.name), cc.map((x) => x.name), 'the list is the course\'s concepts in learning order');
  assert.deepEqual(cc.map((x) => x.position), cc.map((_, i) => i));
  assert.ok(lc.length >= 3 && lc.every((x) => x.display_name.length > 0));
  assert.ok(lc.every((x) => ['strong', 'thin', 'missing'].includes(x.band)));
});

db('a narrative build is exactly as before: it still writes chapters', async (p) => {
  const c = await approved(p, 'narrow');
  const x = deps(p, c.urls);
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  assert.ok(x.chat.labels.includes('write') && x.chat.labels.includes('quiz'));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_concepts`)).rows[0].n, 0);
});

db('each concept shows the links the research found, and a link that is a vetted library source says so and makes the concept strong with a second link', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 } }, fakeModel({ libraryMatches: { debugging: ['src-a', 'src-b'] } }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    const links = (await p.query(`SELECT l.url, l.library_source_id, l.kind FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging' ORDER BY l.position`, [c.versionId])).rows;
    assert.deepEqual(links.filter((l) => l.library_source_id).map((l) => l.library_source_id).sort(), ['src-a', 'src-b']);
    const band = (await p.query(`SELECT band, library_links, other_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows[0];
    assert.deepEqual([band.band, band.library_links], ['strong', 2]);
    const live = (await p.query(`SELECT band, library_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'caching'`, [c.versionId])).rows[0];
    assert.equal(live.library_links, 0);
    assert.equal(live.band, 'thin', 'live links only: unvetted, so thin however many there are');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('the audience judge is the link-quality pass: a live link it refuses is not shown, a dead link is not shown, and a video is kept without it', async (p) => {
  const c = await approved(p);
  const model = fakeModel({ override: (label, messages) => (label === 'page' && messages.at(-1)!.content.includes('/caching') ? JSON.stringify({ keep: false, kind: 'offtopic', why: 'another profession' }) : undefined) });
  const x = deps(p, c.urls, { reachable: async (u: string) => !u.includes('/sql') }, model);
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  const shown = async (name: string) => (await p.query(`SELECT l.url FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = $2`, [c.versionId, name])).rows.map((r) => r.url as string);
  assert.equal((await shown('caching')).length, 0, 'every live page for caching was refused by the judge');
  assert.equal((await shown('sql')).length, 0, 'unreachable pages are dropped');
  assert.ok((await shown('debugging')).length > 0, 'the judge kept the others');
  const missing = (await p.query(`SELECT band FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'caching'`, [c.versionId])).rows[0].band;
  assert.equal(missing, 'missing');
});

db('a page that cannot be opened to be judged is not shown', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls, { readPage: async () => ({ ok: false as const, reason: 'HTTP 403' }) });
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_links`)).rows[0].n, 0);
  assert.ok((await p.query(`SELECT band FROM list_concepts`)).rows.every((r) => r.band === 'missing'));
});

db('a failed display-name call leaves every concept named by itself; the build still succeeds', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls, {}, fakeModel({ override: (label) => (label === 'dispname' ? 'not json' : undefined) }));
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  const rows = (await p.query(`SELECT k.name, l.display_name FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id`)).rows;
  assert.ok(rows.every((r) => r.display_name === r.name.charAt(0).toUpperCase() + r.name.slice(1)));
});


db('a list course takes its library links itself, even when no research is run: a source the model matched counts only if its text names the concept, and nothing is searched', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b'), ent('src-c')]);
  PAGES['https://src-c.example.org/doc'] = `${filler(20)}Nothing here about the topic at all. ${filler(20)}`;
  try {
    const search = fakeSearch();
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true, search }, fakeModel({ libraryMatches: { debugging: ['src-a', 'src-b', 'src-c'] } }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.equal(search.calls, 0);
    const links = (await p.query(`SELECT l.library_source_id FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows.map((r) => r.library_source_id);
    assert.deepEqual(links.sort(), ['src-a', 'src-b'], 'src-c was matched by the model but never names the concept');
    const band = (await p.query(`SELECT band FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows[0].band;
    assert.equal(band, 'strong');
  } finally {
    delete PAGES['https://src-c.example.org/doc'];
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a stored link from a site that is never used as a source (a social post, a job board) is not shown, whatever the judge says', async (p) => {
  const c = await approved(p);
  const x = deps(p, c.urls);
  assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
  await p.query(`DELETE FROM list_links`);
  // put two stored resources in front of a rebuild: one acceptable, one from LinkedIn
  const k = (await p.query(`SELECT id FROM role_concepts WHERE name = 'sql' AND role_id = $1`, [c.roleId])).rows[0].id;
  await p.query(`DELETE FROM resources WHERE concept_id = $1`, [k]);
  await p.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, checked_at) VALUES ($1,'blog','Fine page','Example','https://fine.example.org/sql','x',$2), ($1,'blog','A post','LinkedIn','https://www.linkedin.com/posts/someone-sql','x',$2)`, [k, NOW]);
  await p.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [c.courseId]);
  await p.query(`UPDATE course_versions SET status = 'failed' WHERE id = $1`, [c.versionId]);
  const v2 = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 2, 'building') RETURNING id`, [c.courseId])).rows[0].id as string;
  const run = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [c.courseId, v2, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [v2, run]);
  const y = deps(p, c.urls, { noResearch: true });
  assert.equal((await buildCourse(y.d, c.courseId)).ok, true);
  const urls = (await p.query(`SELECT l.url FROM list_links l WHERE l.version_id = $1 AND l.concept_id = $2`, [v2, k])).rows.map((r) => r.url);
  assert.deepEqual(urls, ['https://fine.example.org/sql']);
});

const SCENARIO_PAGE = `${filler(10)}A workshop is a structured meeting. Run a workshop with a clear goal. In a workshop, people work through the problem together; a good workshop ends with decisions. ${filler(10)}`;

db('a library link counts toward a concept only if the shared rating function says the source teaches it; a source that only mentions it is not a link', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true }, fakeModel({ libraryMatches: { debugging: ['src-a', 'src-b'] }, mentionOnly: ['debugging'] }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    const row = (await p.query(`SELECT band, library_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows[0];
    assert.deepEqual([row.band, row.library_links], ['missing', 0], 'both sources use the word and teach nothing');
    assert.ok(x.chat.labels.includes('teach'), 'the check was asked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a source that names the concept fewer than three times is not even shown to the judge, and the judge is asked once per source, not once per concept', async (p) => {
  const c = await approved(p);
  PAGES['https://src-d.example.org/doc'] = `${filler(20)}Caching is mentioned once here, and debugging once. ${filler(20)}`;
  const dir = library([ent('src-a'), ent('src-d')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true }, fakeModel({ libraryMatches: { debugging: ['src-a', 'src-d'], caching: ['src-d'] } }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    const links = (await p.query(`SELECT k.name, l.library_source_id FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND l.library_source_id IS NOT NULL ORDER BY 1, 2`, [c.versionId])).rows;
    assert.deepEqual(links.map((l) => [l.name, l.library_source_id]), [['debugging', 'src-a']]);
    assert.equal(x.chat.labels.filter((l) => l === 'teach').length, 1, 'one call, for src-a only');
  } finally {
    delete PAGES['https://src-d.example.org/doc'];
    rmSync(dir, { recursive: true, force: true });
  }
});

db('when the judge cannot be reached no library link is counted, and the build still publishes', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true }, fakeModel({ libraryMatches: { debugging: ['src-a', 'src-b'] }, override: (label) => (label === 'teach' ? 'not json' : undefined) }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_links WHERE library_source_id IS NOT NULL`)).rows[0].n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a library page that is already among the stored resources counts as a library link only if it is taught; otherwise it is an ordinary link', async (p) => {
  const c = await approved(p);
  const dir = library([ent('src-a')]);
  try {
    const first = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true }, fakeModel({ libraryMatches: { debugging: ['src-a'] } }));
    assert.equal((await buildCourse(first.d, c.courseId)).ok, true);
    const k = (await p.query(`SELECT id FROM role_concepts WHERE name = 'debugging' AND role_id = $1`, [c.roleId])).rows[0].id;
    await p.query(`DELETE FROM resources WHERE concept_id = $1`, [k]);
    await p.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, checked_at) VALUES ($1,'article','Source src-a','x','https://src-a.example.org/doc','x',$2)`, [k, NOW]);
    await p.query(`UPDATE courses SET status = 'building', published_version = NULL WHERE id = $1`, [c.courseId]);
    await p.query(`UPDATE course_versions SET status = 'failed' WHERE id = $1`, [c.versionId]);
    const v2 = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 2, 'building') RETURNING id`, [c.courseId])).rows[0].id as string;
    const run = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [c.courseId, v2, NOW])).rows[0].id as number;
    await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [v2, run]);
    const second = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true }, fakeModel({ libraryMatches: { debugging: ['src-a'] }, mentionOnly: ['debugging'] }));
    assert.equal((await buildCourse(second.d, c.courseId)).ok, true);
    const row = (await p.query(`SELECT l.library_source_id, l.url FROM list_links l WHERE l.version_id = $1 AND l.concept_id = $2`, [v2, k])).rows;
    assert.deepEqual(row.map((r) => r.library_source_id), [null], 'still shown if it passes the ordinary checks, but not as a vetted source');
    const band = (await p.query(`SELECT band FROM list_concepts WHERE version_id = $1 AND concept_id = $2`, [v2, k])).rows[0].band;
    assert.equal(band, 'thin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a situation (a scenario concept) is matched by its key words, and is a link only if the same rating function says the source teaches it', async (p) => {
  const c = await approved(p);
  PAGES['https://src-w.example.org/doc'] = SCENARIO_PAGE;
  const dir = library([ent('src-w')]);
  try {
    const withScenario = Object.fromEntries(c.urls.map((u, i) => [u, postingText(SKILLS(i), i < 4 ? ['run a workshop'] : [])]));
    const run = async (mentionOnly: string[]) => {
      const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, noResearch: true, extract: fakeExtract(withScenario) }, fakeModel({ libraryMatches: { 'run a workshop': ['src-w'] }, mentionOnly }));
      return x;
    };
    const x = await run([]);
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    const links = (await p.query(`SELECT l.library_source_id FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'run a workshop'`, [c.versionId])).rows;
    assert.deepEqual(links.map((l) => l.library_source_id), ['src-w']);
  } finally {
    delete PAGES['https://src-w.example.org/doc'];
    rmSync(dir, { recursive: true, force: true });
  }
});
