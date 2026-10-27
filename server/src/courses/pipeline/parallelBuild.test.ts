// The reference and list stages research and rate several concepts at once. The result must be what one at a time gives; calls must overlap, but never
// beyond the limit; and a failure must not leave work running. Real SQL, fake model and search.
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

const { db } = useCourseDb('parbuild', { reset: ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'] });
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


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function meter() {
  const m = { now: {} as Record<string, number>, most: {} as Record<string, number> };
  const wrap = <A extends unknown[], R>(kind: string, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    m.now[kind] = (m.now[kind] ?? 0) + 1;
    m.most[kind] = Math.max(m.most[kind] ?? 0, m.now[kind]!);
    try {
      await sleep(4);
      return await fn(...a);
    } finally {
      m.now[kind]!--;
    }
  };
  return { m, wrap };
}
async function snapshot(p: pg.Pool, courseId: string) {
  const q = async (sql: string) => (await p.query(sql, [courseId])).rows;
  return {
    concepts: await q(`SELECT k.name, lc.display_name, lc.band, lc.library_links, lc.other_links, lc.position FROM list_concepts lc JOIN role_concepts k ON k.id = lc.concept_id WHERE lc.course_id = $1 ORDER BY lc.position`),
    links: await q(`SELECT k.name, l.kind, l.url, l.library_source_id IS NOT NULL AS lib FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.course_id = $1 ORDER BY k.name, l.url`),
    resources: await q(`SELECT k.name, r.kind, r.url FROM resources r JOIN role_concepts k ON k.id = r.concept_id WHERE k.id IN (SELECT concept_id FROM course_concepts WHERE course_id = $1) ORDER BY k.name, r.url`),
    claims: await q(`SELECT k.name, c.claim FROM concept_claims c JOIN role_concepts k ON k.id = c.concept_id WHERE k.id IN (SELECT concept_id FROM course_concepts WHERE course_id = $1) ORDER BY k.name, c.claim`),
  };
}
async function once(p: pg.Pool, concurrency: number, extra: Record<string, unknown> = {}) {
  await p.query('TRUNCATE roles, accounts, library_sources, library_changes, library_role_files CASCADE');
  const dir = library([ent('src-a'), ent('src-b')]);
  try {
    const c = await approved(p);
    const mt = meter();
    const model = fakeModel({ libraryMatches: { debugging: ['src-a', 'src-b'], caching: ['src-a'] } });
    const chat = Object.assign(mt.wrap('model', model), { labels: model.labels }) as Chat & { labels: string[] };
    const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, concurrency, readPage: mt.wrap('page', READ_OK), ...{ reachable: mt.wrap('reachable', async (_u: string) => true), ...extra } }, model);
    const r = await buildCourse({ ...x.d, chat }, c.courseId);
    const counts: Record<string, number> = {};
    for (const l of model.labels) counts[l] = (counts[l] ?? 0) + 1;
    return { r, counts, most: mt.m.most, running: mt.m.now, snap: await snapshot(p, c.courseId) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

db('researching and rating four concepts at a time gives exactly what one at a time gives, with calls overlapping but never past four', async (p) => {
  const serial = await once(p, 1);
  assert.equal(serial.r.ok, true, JSON.stringify(serial.r));
  assert.equal(Math.max(...Object.values(serial.most)), 1);
  const par = await once(p, 4);
  assert.equal(par.r.ok, true, JSON.stringify(par.r));
  assert.deepEqual(par.snap, serial.snap);
  assert.deepEqual(par.counts, serial.counts); // no model call is asked twice or skipped
  assert.deepEqual((par.r as { notes: string[] }).notes, (serial.r as { notes: string[] }).notes);
  assert.ok(par.most.model! > 1 && par.most.model! <= 4, JSON.stringify(par.most));
  assert.ok(par.snap.concepts.length >= 3, 'enough concepts for the overlap to mean something');
});

db('when one concept fails the stage fails with that reason, and no call is still running afterwards', async (p) => {
  const bad = await once(p, 4, { reachable: async (url: string) => { await sleep(2); if (url.includes('two.example.net/caching')) throw new Error('the network is down'); return true; } });
  assert.equal(bad.r.ok, false);
  assert.match((bad.r as { reason: string }).reason, /network is down/);
  assert.deepEqual(Object.values(bad.running).filter((v) => v !== 0), [], 'nothing left in flight');
});
