// The coverage-verdict gate: before a page is admitted it is judged exactly the way the coverage engine will judge it once it is in the library. A page the
// rating would call only a mention is rejected instead of admitted, and sources already admitted that the rating does not count are removed, with the
// history kept (a removed source stays in the database with its status and a library change).
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import type { Chat } from '../../llm.ts';
import type { Hit, SearchClient } from '../pipeline/postings.ts';
import { indexSource, rateSourceText } from '../coverage/coverage.ts';
import { libraryVersion, saveSource } from '../library/db.ts';
import type { LibrarySource } from '../library/load.ts';
import { importTaxonomy, loadTaxonomyFromDb } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { createBudget } from './budget.ts';
import { admitAndRate, admitCandidates, auditAdmitted } from './admit.ts';
import { reconcileGaps } from './gaps.ts';
import { runFinder } from './finder.ts';

const TABLES = ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage', 'library_gaps', 'library_candidates'];
const { db } = useCourseDb('gate', { reset: TABLES });
const SLUG = 'demo-role';
const NOW = new Date('2026-10-20T12:00:00Z');
const TAX: Taxonomy = { role: 'demo role', categories: [{ id: 'sql-querying', name: 'SQL querying', description: 'writing queries against relational data', aliases: ['sql', 'database queries'] }, { id: 'testing-uat', name: 'Testing and user acceptance', description: 'running acceptance tests', aliases: ['uat'] }], tools: [] };
const WEB: Record<string, string> = {
  'https://good-one.example.org/sql': 'SQL is a language for relational data. Learn SQL joins. SQL grouping and SQL filters are explained here step by step with examples of database queries.',
  'https://good-two.example.net/sql-guide': 'A guide to SQL for analysts. SQL select statements. SQL where clauses. More SQL and database queries explained in depth for beginners.',
};
const hits = (...urls: string[]): Hit[] => urls.map((url) => ({ url, title: `Page ${url.split('/').pop()}`, text: '' }));
const read = async (s: { id: string; url: string }) => (WEB[s.url] ? ({ ok: true as const, id: s.id, text: WEB[s.url]!, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
/** A model that answers every question "yes / teaches" except the teaches-judge calls its predicate refuses; it counts those calls. */
function model(refuse: (n: number, user: string) => boolean | 'down' = () => false): Chat & { n: number } {
  const chat = (async (m: Array<{ content: string }>) => {
    const system = m[0]!.content;
    const user = m.at(-1)!.content;
    if (/web page is a good source/.test(system)) return JSON.stringify({ keep: true, kind: 'secondary', why: 'a clear explanation for analysts' });
    if (/MAIN SUBJECT/.test(system)) return JSON.stringify({ answer: 'yes' });
    if (/TEACHES a skill or only mentions it/.test(system)) {
      const n = ++chat.n;
      const r = refuse(n, user);
      if (r === 'down') throw new Error('model down');
      const ask = JSON.parse(user) as { categories: Array<{ id: string; excerpts: string[] }> };
      return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: r ? 'mentions' : 'teaches', evidence: c.excerpts[0]!.slice(10, 80) })) });
    }
    return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
  }) as unknown as Chat & { n: number };
  chat.n = 0;
  return chat;
}
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over }) as LibrarySource;
async function proposed(p: Parameters<typeof importTaxonomy>[0]) {
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('own-1'), SLUG, 'seed');
  const v = await libraryVersion(p);
  for (const c of TAX.categories) await p.query(`INSERT INTO category_coverage (role_slug, category_id, library_version, band, min_hits, source_ids) VALUES ($1,$2,$3,'missing',3,'[]')`, [SLUG, c.id, v]);
  await reconcileGaps(p, SLUG);
  const search: SearchClient = { search: async () => hits('https://good-one.example.org/sql', 'https://good-two.example.net/sql-guide') };
  await runFinder({ pool: p, chat: model(), search, read, budget: createBudget({ perGap: 4, batch: 20, ledger: { charge() {} } }), now: () => NOW }, SLUG, ['sql-querying']);
}
const rows = async (p: Parameters<typeof importTaxonomy>[0]) => Object.fromEntries((await p.query(`SELECT url, status, reason FROM library_candidates`)).rows.map((x) => [x.url as string, x as { status: string; reason: string }]));

db('the verdict the gate reads is the verdict the coverage engine stores for the same page, because they are the same function', async (p) => {
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('src-x', { url: 'https://good-one.example.org/sql' }), SLUG, 'finder');
  const tax = (await loadTaxonomyFromDb(p, SLUG))!;
  const chat = model();
  const rated = await rateSourceText(chat, { name: 'Source src-x', why: 'Trusted.' }, WEB['https://good-one.example.org/sql']!, tax.categories, 3);
  await indexSource(p, SLUG, 'src-x', read, model());
  const stored = (await p.query(`SELECT category_id, hits, verdict FROM library_source_categories WHERE source_id = 'src-x'`)).rows;
  assert.deepEqual(stored.map((s) => [s.category_id, s.hits, s.verdict]).sort(), [...rated].map(([id, r]) => [id, r.hits, r.verdict]).sort());
});

db('a page that passes the two-run screen but that the rating would call only a mention is rejected, not admitted, and the reason is recorded', async (p) => {
  await proposed(p);
  const before = await libraryVersion(p);
  // the screen's own teaches question is call 1 and the gate's is call 2, for each page in turn: refuse the gate's question for the first page
  const r = await admitCandidates({ pool: p, chat: model((n) => n === 2), read, now: () => NOW }, SLUG);
  assert.equal(r.admitted.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /would call it only a mention/);
  const by = await rows(p);
  const refused = Object.values(by).filter((x) => x.status === 'rejected' && /coverage/.test(x.reason));
  assert.equal(refused.length, 1);
  assert.match(refused[0]!.reason, /failed the coverage check: the rating would call it only a mention/);
  assert.equal(await libraryVersion(p), before + 1, 'only the page that would count was added');
});

db('if the gate cannot be completed the page is not admitted and stays proposed, never guessed at', async (p) => {
  await proposed(p);
  const before = await libraryVersion(p);
  const r = await admitCandidates({ pool: p, chat: model((n) => (n % 2 === 0 ? 'down' : false)), read, now: () => NOW }, SLUG);
  assert.equal(r.admitted.length, 0);
  assert.equal(await libraryVersion(p), before);
  assert.ok(Object.values(await rows(p)).every((x) => x.status === 'proposed' && /could not be completed/.test(x.reason)));
});

db('an admitted source that the rating does not count is removed: its status becomes removed, one library change each, the candidate is rejected with the reason, and the rating is made again', async (p) => {
  await proposed(p);
  // admitted while the gate did not exist: both pages are in, but the rating's own judging calls the first a mention
  await admitCandidates({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  const ids = (await p.query(`SELECT id FROM library_sources WHERE origin = 'finder' ORDER BY id`)).rows.map((x) => x.id as string);
  assert.equal(ids.length, 2);
  const first = await indexSource(p, SLUG, ids[0]!, read, model((n) => n === 1));
  await indexSource(p, SLUG, ids[1]!, read, model());
  assert.ok(first.ok);
  const before = await libraryVersion(p);
  const out = await auditAdmitted({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  assert.deepEqual(out.removed.map((x) => x.id), [ids[0]]);
  assert.equal(await libraryVersion(p), before + 1);
  const src = (await p.query(`SELECT status FROM library_sources WHERE id = $1`, [ids[0]])).rows[0];
  assert.equal(src.status, 'removed', 'still in the database, with its history');
  const change = (await p.query(`SELECT kind, summary FROM library_changes WHERE version = $1`, [before + 1])).rows[0];
  assert.equal(change.kind, 'status');
  assert.match(change.summary, /removed/);
  const cand = (await p.query(`SELECT status, reason FROM library_candidates WHERE draft->>'id' = $1`, [ids[0]])).rows[0];
  assert.deepEqual([cand.status, /failed the coverage check/.test(cand.reason)], ['rejected', true]);
  assert.equal((await p.query(`SELECT status FROM library_sources WHERE id = $1`, [ids[1]])).rows[0].status, 'active');
  // idempotent: a second audit removes nothing more and does not move the version
  const v2 = await libraryVersion(p);
  assert.deepEqual((await auditAdmitted({ pool: p, chat: model(), read, now: () => NOW }, SLUG)).removed, []);
  assert.equal(await libraryVersion(p), v2);
});

db('the audit never touches a seed source, and a source that the rating counts stays', async (p) => {
  await proposed(p);
  const out = await admitAndRate({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  assert.ok(out.coverage.ok);
  const before = await libraryVersion(p);
  const audit = await auditAdmitted({ pool: p, chat: model(), read, now: () => NOW }, SLUG);
  assert.deepEqual(audit.removed, []);
  assert.equal(await libraryVersion(p), before);
  assert.equal((await p.query(`SELECT status FROM library_sources WHERE id = 'own-1'`)).rows[0].status, 'active');
});
