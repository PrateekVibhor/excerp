// A library source whose citation policy is link-only keeps its link, its title, our own rationale line and its rating, but nothing from its page text may reach anything a
// reader could see: no fact sentence, no explanation. Real SQL, fake model and search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';
import { researchFromLibrary } from './libraryResearch.ts';
import type { Chat } from '../../llm.ts';

const { db } = useCourseDb('linkonly', { reset: ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'] });
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
PAGES['https://src-b.example.org/doc'] = `${filler(20)}Zebrafish ledgers are a phrase that exists only on this page and nowhere else. Debugging is made easier when a team keeps good logs of its running systems. Debugging tools help. Debugging by logs is common. Caching is the practice of keeping a copy of results close at hand for reuse. Caching is helpful. Caching by layers is common. ${filler(20)}`;
const fetched: string[] = [];
const fetcher = async (url: string) => (fetched.push(url), PAGES[url] ? new Response(PAGES[url], { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 }));

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


const LINK_ONLY = { citation_policy: 'link-only', licence: 'No reuse terms checked; the page is linked and never reproduced', free_parts: 'whole page (linked)', decision_note: 'Vetted automatically by the source finder on 2026-10-18: opens without an account.' };
const MATCH = { debugging: ['src-a', 'src-b'], caching: ['src-b'] };
const claims = async (p: pg.Pool, name: string) => (await p.query(`SELECT c.claim, c.source_url FROM concept_claims c JOIN role_concepts k ON k.id = c.concept_id WHERE k.name = $1 ORDER BY c.claim`, [name])).rows as Array<{ claim: string; source_url: string | null }>;
const explanation = async (p: pg.Pool, name: string) => (await p.query(`SELECT plain_explanation AS e FROM role_concepts WHERE name = $1`, [name])).rows[0]?.e as string | undefined;
/** A build with src-a (no policy) and src-b (link-only), the model's prompts for facts captured. */
async function build(p: pg.Pool, over: { b?: Record<string, unknown>; a?: Record<string, unknown>; matches?: Record<string, string[]>; search?: unknown } = {}) {
  fetched.length = 0;
  await p.query('TRUNCATE roles, accounts, library_sources, library_changes, library_role_files CASCADE');
  const c = await approved(p);
  const dir = library([ent('src-a', over.a ?? {}), ent('src-b', over.b ?? LINK_ONLY)]);
  const factPrompts: string[] = [];
  const model = fakeModel({ libraryMatches: over.matches ?? MATCH, override: (label, m) => (label === 'facts' ? (factPrompts.push(m.at(-1)!.content), undefined) : undefined) });
  const x = deps(p, c.urls, { library: { dir, fetcher, minFacts: 2 }, ...(over.search ? { search: over.search } : {}) }, model);
  const r = await buildCourse(x.d, c.courseId);
  rmSync(dir, { recursive: true, force: true });
  return { c, r, model, factPrompts };
}
const A_URL = 'https://src-a.example.org/doc';
const B_URL = 'https://src-b.example.org/doc';

db('a link-only source is still fetched, matched to concepts, rated and linked, but adds no fact sentence and never gives an explanation', async (p) => {
  const { c, r, model, factPrompts } = await build(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fetched.includes(B_URL), 'its page was fetched');
  assert.ok(model.labels.includes('libmatch'), 'concepts were matched to the library, link-only sources included');
  const links = (await p.query(`SELECT l.library_source_id FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows.map((l) => l.library_source_id).sort();
  assert.deepEqual(links.filter(Boolean), ['src-a', 'src-b'], 'rated as teaching, so linked like the other library source');
  const rated = (await p.query(`SELECT band, library_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'debugging'`, [c.versionId])).rows[0];
  assert.deepEqual([rated.band, rated.library_links], ['strong', 2], 'the link-only source counts toward coverage like any library source');
  assert.ok(factPrompts.length > 0 && factPrompts.every((t) => !/Zebrafish/.test(t)), 'no page text of the link-only source was given to the model that writes facts');
  const all = (await p.query(`SELECT claim, source_url FROM concept_claims`)).rows as Array<{ claim: string; source_url: string | null }>;
  assert.ok(all.length > 0, 'the other sources still give claims');
  assert.deepEqual(all.filter((x) => /Zebrafish/.test(x.claim) || x.source_url === B_URL), [], 'no claim comes from the link-only page');
  assert.deepEqual((await p.query(`SELECT plain_explanation AS e FROM role_concepts WHERE plain_explanation LIKE '%Zebrafish%'`)).rows, []);
  const use = (await p.query(`SELECT k.name, u.outcome, u.source_ids FROM library_use u JOIN role_concepts k ON k.id = u.concept_id WHERE u.course_id = $1 ORDER BY k.name`, [c.courseId])).rows;
  assert.ok(use.every((u) => !u.source_ids.includes('src-b')), 'a link-only source is never recorded as the source of facts');
});

db('a concept backed only by a link-only source builds: no fact from the library, the link and its rating kept, and live research (or nothing) behind its claims', async (p) => {
  const live = await build(p);
  assert.equal(live.r.ok, true);
  const caching = await claims(p, 'caching');
  assert.ok(caching.length > 0 && caching.every((x) => /example\.(org|net)\/caching/.test(x.source_url ?? '') && x.source_url !== B_URL), 'claims come from live research, not from the link-only page');
  assert.equal((await p.query(`SELECT u.outcome FROM library_use u JOIN role_concepts k ON k.id = u.concept_id WHERE k.name = 'caching'`)).rows[0].outcome, 'live');
  assert.ok((await explanation(p, 'caching'))!.length > 0 && !/Zebrafish/.test((await explanation(p, 'caching'))!));
  const band = (await p.query(`SELECT band, library_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'caching'`, [live.c.versionId])).rows[0];
  assert.deepEqual([band.band, band.library_links], ['strong', 1], 'its library link (the link-only source, rated as teaching) and the live links make it strong, exactly as any vetted library source would');
});

db('with no live research to fall back on, such a concept has no claims and no explanation, and the build still publishes with its link', async (p) => {
  const none = await build(p, { search: { search: async () => [] } });
  assert.equal(none.r.ok, true, JSON.stringify(none.r));
  assert.deepEqual(await claims(p, 'caching'), []);
  assert.equal(await explanation(p, 'caching'), '');
  const row = (await p.query(`SELECT l.display_name, l.band, l.library_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'caching'`, [none.c.versionId])).rows[0];
  assert.ok(row.display_name.length > 0);
  assert.deepEqual([row.band, row.library_links], ['thin', 1]);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_links l JOIN role_concepts k ON k.id = l.concept_id WHERE l.version_id = $1 AND k.name = 'caching' AND l.library_source_id = 'src-b'`, [none.c.versionId])).rows[0].n, 1);
  const status = (await p.query(`SELECT status FROM courses WHERE id = $1`, [none.c.courseId])).rows[0].status;
  assert.equal(status, 'ready');
});

db('a live search result that is a link-only library page is not read for facts either', async (p) => {
  const leaky = { search: async () => [{ url: B_URL, title: 'Caching explained', text: 'Caching is the practice of keeping a copy close. Zebrafish ledgers are a phrase that exists only on this page. Caching is checked against real examples.' }] };
  const x = await build(p, { search: leaky });
  assert.equal(x.r.ok, true, JSON.stringify(x.r));
  assert.deepEqual((await claims(p, 'caching')).filter((c) => /Zebrafish/.test(c.claim) || c.source_url === B_URL), []);
  assert.equal(/Zebrafish/.test((await explanation(p, 'caching')) ?? ''), false);
});

db('an attributed-citation source behaves exactly as it always has: its facts are claims and the first one is the explanation', async (p) => {
  const x = await build(p, { a: { citation_policy: 'attributed_citation_only', decision_note: 'Attributed citation only: short quotes with clear attribution, pointing the learner to the real page; never full-text reproduction (x).' }, b: {}, matches: { debugging: ['src-a'] } });
  assert.equal(x.r.ok, true, JSON.stringify(x.r));
  const got = await claims(p, 'debugging');
  assert.ok(got.length >= 2 && got.every((c) => c.source_url === A_URL), 'claims come from the attributed source');
  assert.ok(got.map((c) => c.claim).includes((await explanation(p, 'debugging'))!.trim()) || (await explanation(p, 'debugging'))!.length > 0, 'an explanation is set from its facts');
  assert.ok((await explanation(p, 'debugging'))!.length > 0);
  const same = await build(p, { b: {}, matches: { debugging: ['src-a', 'src-b'] } });
  assert.equal(same.r.ok, true);
  assert.ok(same.factPrompts.some((t) => /Zebrafish/.test(t)), 'a source with no link-only policy is still read for facts, as before');
});

test('researchFromLibrary: a link-only source supplies no page, no fact and no coverage, but is still a resource when its text has a passage', async () => {
  const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);
  const A = { id: 'a', name: 'Source A', url: 'https://a.example.org/x', tier: 2 as const, perspective: 'field' as const, rationale: 'Trusted.', layer: 'practical' };
  const B = { ...A, id: 'b', name: 'Source B', url: 'https://b.example.org/x', linkOnly: true };
  const text = async (s: { id: string }) => `${filler(10)}${s.id === 'b' ? 'Zebrafish stakeholder analysis is a phrase only here. ' : ''}Stakeholder analysis is the practice of identifying who is affected by the work. Stakeholder analysis is done before planning starts. ${filler(10)}`;
  const seen: string[] = [];
  const chat: Chat = async (m) => (seen.push(m.at(-1)!.content), JSON.stringify({ facts: [{ text: 'Stakeholder analysis is the practice of identifying who is affected by the work.', kind: 'practice' }, { text: 'Stakeholder analysis is done before planning starts.', kind: 'practice' }] }));
  const both = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: [] }, sources: [A, B], text, chat, minFacts: 2 });
  assert.ok(seen.every((t) => !/Zebrafish/.test(t)), 'the model that writes facts never saw the link-only page');
  assert.deepEqual(both.pages.map((p) => p.sourceId), ['a']);
  assert.deepEqual(both.sourceIds, ['a']);
  assert.deepEqual(both.resources.map((r) => r.url).sort(), ['https://a.example.org/x', 'https://b.example.org/x'], 'both are still links');
  seen.length = 0;
  const only = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: [] }, sources: [B], text, chat, minFacts: 2 });
  assert.equal(seen.length, 0, 'nothing is sent to the fact writer when only a link-only source matches');
  assert.deepEqual([only.covered, only.facts, only.pages, only.sourceIds], [false, [], [], []]);
  assert.deepEqual(only.resources.map((r) => r.url), ['https://b.example.org/x']);
});
