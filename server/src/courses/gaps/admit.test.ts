// Admission: a proposed page is added to the library only if it passes the full screen again, on a second independent run. Everything goes through the
// normal write path, so each admitted source is one library change and one library version. A gap is filled only when the stored rating says strong.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import type { Chat } from '../../llm.ts';
import type { Hit, SearchClient } from '../pipeline/postings.ts';
import { refreshCoverage } from '../coverage/coverage.ts';
import { libraryVersion, saveSource, loadLibraryFromDb } from '../library/db.ts';
import type { LibrarySource } from '../library/load.ts';
import { sourcesFor } from '../library/load.ts';
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { createBudget } from './budget.ts';
import { admitAndRate, admitCandidates } from './admit.ts';
import { reconcileGaps } from './gaps.ts';
import { runFinder } from './finder.ts';

const TABLES = ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage', 'library_gaps', 'library_candidates'];
const { db } = useCourseDb('admit', { reset: TABLES });
const SLUG = 'demo-role';
const NOW = new Date('2026-10-20T12:00:00Z');
const TAX: Taxonomy = { role: 'demo role', categories: [{ id: 'sql-querying', name: 'SQL querying', description: 'writing queries against relational data', aliases: ['sql', 'database queries'] }, { id: 'testing-uat', name: 'Testing and user acceptance', description: 'running acceptance tests', aliases: ['uat'] }], tools: [] };
const WEB: Record<string, string> = {
  'https://good-one.example.org/sql': 'SQL is a language for relational data. Learn SQL joins. SQL grouping and SQL filters are explained here step by step with examples of database queries.',
  'https://good-two.example.net/sql-guide': 'A guide to SQL for analysts. SQL select statements. SQL where clauses. More SQL and database queries explained in depth for beginners.',
};
const hits = (...urls: string[]): Hit[] => urls.map((url) => ({ url, title: `Page ${url.split('/').pop()}`, text: '' }));
const read = (log: string[] = []) => async (s: { id: string; url: string }) => (log.push(s.url), WEB[s.url] ? ({ ok: true as const, id: s.id, text: WEB[s.url]!, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
/** A model whose answers can differ between runs: `failOn` says, per call number of a kind, when to refuse. */
function model(opts: { audienceNo?: (n: number, user: string) => boolean; teachesNo?: (n: number, user: string) => boolean } = {}): Chat & { counts: Record<string, number> } {
  const counts: Record<string, number> = { audience: 0, teaches: 0, verify: 0, subject: 0 };
  const chat = (async (m: Array<{ content: string }>) => {
    const system = m[0]!.content;
    const user = m.at(-1)!.content;
    if (/web page is a good source/.test(system)) { const n = ++counts.audience!; const no = opts.audienceNo?.(n, user); return JSON.stringify({ keep: !no, kind: no ? 'offtopic' : 'secondary', why: no ? 'another profession' : 'a clear explanation for analysts' }); }
    if (/TEACHES a skill or only mentions it/.test(system)) { const n = ++counts.teaches!; const ask = JSON.parse(user) as { categories: Array<{ id: string; excerpts: string[] }> }; const no = opts.teachesNo?.(n, user); return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: no ? 'mentions' : 'teaches', evidence: c.excerpts[0]!.slice(10, 80) })) }); }
    if (/MAIN SUBJECT/.test(system)) { counts.subject!++; return JSON.stringify({ answer: 'yes' }); }
    counts.verify!++;
    return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
  }) as unknown as Chat & { counts: Record<string, number> };
  chat.counts = counts;
  return chat;
}
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over }) as LibrarySource;

/** A library with one seed source, a rating that calls both categories missing, and the finder's first run already done. */
async function proposed(p: Parameters<typeof importTaxonomy>[0], urls: string[] = ['https://good-one.example.org/sql', 'https://good-two.example.net/sql-guide'], cat = 'sql-querying') {
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('own-1'), SLUG, 'seed');
  const v = await libraryVersion(p);
  for (const c of TAX.categories) await p.query(`INSERT INTO category_coverage (role_slug, category_id, library_version, band, min_hits, source_ids) VALUES ($1,$2,$3,'missing',3,'[]')`, [SLUG, c.id, v]);
  await reconcileGaps(p, SLUG);
  const search: SearchClient = { search: async () => hits(...urls) };
  const l = { charge() {} };
  const first = model();
  await runFinder({ pool: p, chat: first, search, read: read(), budget: createBudget({ perGap: 4, batch: 20, ledger: l }), now: () => NOW }, SLUG, [cat]);
}
const status = async (p: Parameters<typeof importTaxonomy>[0]) => (await p.query(`SELECT url, status, reason, admitted_version FROM library_candidates ORDER BY url`)).rows;

db('a proposed page that passes the full screen again is added through the normal write path: one library change and one version each', async (p) => {
  await proposed(p);
  const before = await libraryVersion(p);
  const r = await admitCandidates({ pool: p, chat: model(), read: read(), now: () => NOW }, SLUG);
  assert.equal(r.admitted.length, 2);
  assert.deepEqual([r.version.before, r.version.after], [before, before + 2]);
  assert.equal(await libraryVersion(p), before + 2);
  const changes = (await p.query(`SELECT kind, source_id FROM library_changes WHERE version > $1 ORDER BY version`, [before])).rows;
  assert.deepEqual(changes.map((c) => c.kind), ['added', 'added']);
  const rows = await status(p);
  assert.deepEqual(rows.map((x) => x.status), ['admitted', 'admitted']);
  assert.ok(rows.every((x) => Number(x.admitted_version) > before));
  const lib = await loadLibraryFromDb(p);
  const added = sourcesFor(lib, SLUG).filter((s) => s.id !== 'own-1');
  assert.equal(added.length, 2);
  for (const s of added) {
    assert.match(String(s.decision_note), /two independent runs/);
    assert.equal(s.citation_policy, 'link-only');
    assert.equal(typeof s.tier, 'number');
    assert.equal((await p.query(`SELECT origin FROM library_sources WHERE id = $1`, [s.id])).rows[0].origin, 'finder');
  }
});

db('a page that fails the second run stays proposed with the reason recorded, and nothing of it is added', async (p) => {
  await proposed(p);
  const before = await libraryVersion(p);
  // the second run's audience question refuses the second page only
  const r = await admitCandidates({ pool: p, chat: model({ audienceNo: (_n, user) => user.includes('sql-guide') }), read: read(), now: () => NOW }, SLUG);
  assert.equal(r.admitted.length, 1);
  assert.deepEqual(r.kept.map((k) => k.url), ['https://good-two.example.net/sql-guide']);
  assert.match(r.kept[0]!.reason, /failed the second run: not written for this role/);
  const by = Object.fromEntries((await status(p)).map((x) => [x.url as string, x]));
  assert.equal(by['https://good-two.example.net/sql-guide'].status, 'proposed');
  assert.match(by['https://good-two.example.net/sql-guide'].reason, /failed the second run/);
  assert.equal(by['https://good-one.example.org/sql'].status, 'admitted');
  assert.equal(await libraryVersion(p), before + 1);
});

db('a page that cannot be opened or turns out to be a mention only on the second run is not admitted either', async (p) => {
  await proposed(p);
  const gone = async (s: { id: string; url: string }) => (s.url.includes('good-one') ? ({ ok: false as const, id: s.id, reason: 'HTTP 404' }) : read()(s));
  const r = await admitCandidates({ pool: p, chat: model({ teachesNo: (_n, user) => user.includes('sql-guide') }), read: gone, now: () => NOW }, SLUG);
  assert.equal(r.admitted.length, 0);
  assert.equal(r.kept.length, 2);
  assert.ok(r.kept.some((k) => /could not be opened/.test(k.reason)) && r.kept.some((k) => /only mentions the skill/.test(k.reason)));
});

db('running admission again adds nothing twice, and a page that has meanwhile entered the library is not added again', async (p) => {
  await proposed(p);
  await admitCandidates({ pool: p, chat: model(), read: read(), now: () => NOW }, SLUG);
  const v = await libraryVersion(p);
  const again = await admitCandidates({ pool: p, chat: model(), read: read(), now: () => NOW }, SLUG);
  assert.deepEqual([again.admitted.length, again.kept.length, await libraryVersion(p)], [0, 0, v]);
});

db('admission needs no search and spends no credits: it takes only the database, the model and a page reader', async (p) => {
  await proposed(p);
  const deps = { pool: p, chat: model(), read: read(), now: () => NOW };
  assert.deepEqual(Object.keys(deps).sort(), ['chat', 'now', 'pool', 'read']);
  await admitCandidates(deps, SLUG);
});

db('after admission the coverage engine rates the new library version, and a gap is filled only when that stored rating says strong', async (p) => {
  await proposed(p);
  const before = await libraryVersion(p);
  const out = await admitAndRate({ pool: p, chat: model(), read: read(), now: () => NOW }, SLUG);
  assert.ok(out.coverage.ok);
  const after = await libraryVersion(p);
  assert.equal(after, before + 2);
  const rated = (await p.query(`SELECT band FROM category_coverage WHERE role_slug = $1 AND category_id = 'sql-querying' AND library_version = $2`, [SLUG, after])).rows[0];
  assert.equal(rated.band, 'strong', 'both pages teach it, so the stored rating at the new version is strong');
  const gap = (await p.query(`SELECT status, filled_version FROM library_gaps WHERE category_id = 'sql-querying'`)).rows[0];
  assert.deepEqual([gap.status, Number(gap.filled_version)], ['filled', after]);
  assert.equal((await p.query(`SELECT status FROM library_gaps WHERE category_id = 'testing-uat'`)).rows[0].status, 'open', 'a gap nobody touched is still open');
});

db('one admitted page leaves the category thin and the gap open, not filled and not waiting; a page the rating itself judges as only mentioning leaves it missing', async (p) => {
  await proposed(p, ['https://good-one.example.org/sql']);
  const out = await admitAndRate({ pool: p, chat: model(), read: read(), now: () => NOW }, SLUG);
  assert.ok(out.coverage.ok);
  const v = await libraryVersion(p);
  assert.equal((await p.query(`SELECT band FROM category_coverage WHERE category_id = 'sql-querying' AND library_version = $1`, [v])).rows[0].band, 'thin');
  assert.equal((await p.query(`SELECT status FROM library_gaps WHERE category_id = 'sql-querying'`)).rows[0].status, 'open');

  // the rating asks its own questions: a page admitted by the screen but judged only a mention there does not count
  const p2 = p;
  await p2.query(`DELETE FROM library_candidates`);
  await p2.query(`UPDATE library_sources SET status = 'flagged' WHERE id <> 'own-1'`);
  const strict = model({ teachesNo: () => true });
  await p2.query(`DELETE FROM library_source_index`);
  const rated = await refreshCoverage(p2, SLUG, read(), strict);
  assert.ok(rated.ok && rated.rows.find((r) => r.category === 'sql-querying')!.band === 'missing');
});
