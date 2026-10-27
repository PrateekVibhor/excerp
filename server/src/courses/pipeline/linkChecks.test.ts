// A link is checked once per build (reachable, read, judged) and a judged page is remembered, so the list stage and a rebuild do not ask again; the judge
// can be a separate model. Real SQL, fake model and search.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';
import type { Chat } from '../../llm.ts';

const { db } = useCourseDb('linkchecks', { reset: ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'] });
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



type Counts = { reach: Record<string, number>; read: Record<string, number> };
function counting(): { counts: Counts; reachable: (u: string) => Promise<boolean>; readPage: typeof READ_OK } {
  const counts: Counts = { reach: {}, read: {} };
  return {
    counts,
    reachable: async (u) => ((counts.reach[u] = (counts.reach[u] ?? 0) + 1), true),
    readPage: (async (u: string) => ((counts.read[u] = (counts.read[u] ?? 0) + 1), READ_OK())) as unknown as typeof READ_OK,
  };
}
const page = (m: { labels: string[] }) => m.labels.filter((l) => l === 'page').length;
const links = async (p: pg.Pool, courseId: string) => (await p.query(`SELECT k.name, l.url FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.course_id = $1 AND l.version_id = (SELECT id FROM course_versions WHERE course_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1) ORDER BY k.name, l.url`, [courseId])).rows;
async function requeue(p: pg.Pool, courseId: string) {
  await p.query(`UPDATE courses SET status = 'building' WHERE id = $1`, [courseId]);
  const v = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, (SELECT max(version) + 1 FROM course_versions WHERE course_id = $1), 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const run = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, v, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [v, run]);
}
const matches = { libraryMatches: { debugging: ['src-a', 'src-b'], caching: ['src-a'] } };

db('within one build a link is checked and read at most once, and a page is judged once for the research and once for the list, and each verdict is remembered', async (p) => {
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const c = await approved(p);
    const model = fakeModel(matches);
    const k = counting();
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, reachable: k.reachable, readPage: k.readPage }, model);
    const r = await buildCourse(x.d, c.courseId);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Object.keys(k.counts.reach).length > 0, 'links were checked');
    assert.deepEqual(Object.entries(k.counts.reach).filter(([, n]) => n > 1), [], 'no link checked twice');
    assert.deepEqual(Object.entries(k.counts.read).filter(([, n]) => n > 1), [], 'no page read twice');
    const judged = Number((await p.query(`SELECT count(*) FROM link_judgments`)).rows[0].count);
    assert.equal(page(model), judged, 'every page judged once per stage, and each judgment remembered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a rebuild asks the model about no page it has judged, and the list comes out the same', async (p) => {
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const c = await approved(p);
    const first = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 } }, fakeModel(matches));
    assert.equal((await buildCourse(first.d, c.courseId)).ok, true);
    const before = await links(p, c.courseId);
    assert.ok(before.length > 0);
    await p.query(`UPDATE course_versions SET status = 'published' WHERE course_id = $1 AND status = 'building'`, [c.courseId]);
    await requeue(p, c.courseId);
    const model = fakeModel(matches);
    const k = counting();
    const again = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, reachable: k.reachable, readPage: k.readPage }, model);
    assert.equal((await buildCourse(again.d, c.courseId)).ok, true);
    await p.query(`UPDATE course_versions SET status = 'published' WHERE course_id = $1 AND status = 'building'`, [c.courseId]);
    assert.equal(page(model), 0, 'no page judged again');
    assert.deepEqual(await links(p, c.courseId), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a page that could not be judged is not remembered', async (p) => {
  const dir = library([ent('src-a')]);
  try {
    const c = await approved(p);
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 } }, fakeModel({ ...matches, override: (label) => (label === 'page' ? 'not json' : undefined) }));
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.equal(Number((await p.query(`SELECT count(*) FROM link_judgments`)).rows[0].count), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('web pages are judged by the judge model when one is given, and by nothing else', async (p) => {
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const c = await approved(p);
    const main = fakeModel(matches);
    const judge = fakeModel(matches);
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, judgeChat: judge, judgeId: 'small-model' }, main);
    assert.equal((await buildCourse(x.d, c.courseId)).ok, true);
    assert.equal(page(main), 0, 'the main model judged no page');
    assert.ok(page(judge) > 0 && judge.labels.every((l) => l === 'page'), `the judge model was asked only to judge pages: ${[...new Set(judge.labels)]}`);
    assert.deepEqual((await p.query(`SELECT DISTINCT judge FROM link_judgments ORDER BY 1`)).rows, [{ judge: 'small-model|list|1' }, { judge: 'small-model|research|1' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
