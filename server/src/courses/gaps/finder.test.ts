// Source finder, dry run: for a gap it searches, screens every page it finds (not a job board, not already in the library, opens without an account,
// written for the role, names the category often enough, and TEACHES it by the same two-step check coverage uses), drafts a library entry for each page that
// passes, and records why every other page did not. Nothing is added to the library.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import type { Chat } from '../../llm.ts';
import type { Hit, SearchClient, SearchParams } from '../pipeline/postings.ts';
import { saveSource, libraryVersion } from '../library/db.ts';
import { validateLibrary, type LibrarySource } from '../library/load.ts';
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { createBudget } from './budget.ts';
import { reconcileGaps } from './gaps.ts';
import { runFinder, teachesCheck } from './finder.ts';

const TABLES = ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage', 'library_gaps', 'library_candidates'];
const { db } = useCourseDb('finder', { reset: TABLES });
const SLUG = 'demo-role';
const NOW = new Date('2026-10-20T12:00:00Z');
const TAX: Taxonomy = {
  role: 'demo role',
  categories: [
    { id: 'sql-querying', name: 'SQL querying', description: 'writing queries against relational data', aliases: ['sql', 'database queries'] },
    { id: 'testing-uat', name: 'Testing and user acceptance', description: 'planning and running acceptance tests', aliases: ['user acceptance testing', 'uat'] },
  ],
  tools: [],
};
const ent = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
}) as LibrarySource;

/** What the web "has": url -> page text. */
const WEB: Record<string, string> = {
  'https://good-one.example.org/sql': 'SQL is a language for relational data. Learn SQL joins. SQL grouping and SQL filters are explained here step by step with examples of database queries.',
  'https://good-two.example.net/sql-guide': 'A guide to SQL for analysts. SQL select statements. SQL where clauses. More SQL and database queries explained in depth for beginners.',
  'https://only-mentions.example.org/blog': 'We use SQL, SQL, SQL in our stack but this post is about hiring. SQL. ',
  'https://few-hits.example.org/post': 'A long essay about analysis that names SQL once.',
  'https://wrong-field.example.org/ds': 'SQL for data scientists building machine learning pipelines: SQL, SQL, SQL feature stores.',
  'https://pdf-copy.example.org/book.pdf': 'SQL book text. SQL is taught here. SQL joins. SQL grouping. Database queries. A whole book of SQL.',
  'https://list-post.example.org/best-practices': 'Ten best practices for analysts. Number seven: learn SQL. SQL helps. Also SQL. Many other things follow in this long list of tips.',
  'https://uat-guide.example.org/uat': 'User acceptance testing explained. UAT plans, UAT scripts and UAT sign-off. User acceptance testing is run by business users.',
};
const hit = (url: string): Hit => ({ url, title: `Page ${url.split('/').pop()}`, text: WEB[url] ?? 'unreachable page text' });

function setupSearch(byQuery: (q: string) => string[]) {
  const queries: SearchParams[] = [];
  const search: SearchClient = { search: async (p) => (queries.push(p), byQuery(p.query).map(hit)) };
  return { search, queries };
}
const read = (log: string[] = []) => async (s: { id: string; url: string }) => {
  log.push(s.url);
  const text = WEB[s.url];
  return text ? ({ ok: true as const, id: s.id, text, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' });
};
/** The model: audience judge, teaches judge and verifier. */
function model(opts: { wrongField?: string[]; mentions?: string[]; verifyNo?: string[]; notSubject?: string[] } = {}): Chat & { calls: string[] } {
  const calls: string[] = [];
  const chat = (async (m: Array<{ content: string }>) => {
    const system = m[0]!.content;
    const user = m.at(-1)!.content;
    if (/web page is a good source/.test(system)) {
      calls.push('audience');
      const off = (opts.wrongField ?? []).some((u) => user.includes(u));
      return JSON.stringify({ keep: !off, kind: off ? 'offtopic' : 'secondary', why: off ? 'written for another profession' : 'a clear explanation for analysts' });
    }
    if (/TEACHES a skill or only mentions it/.test(system)) {
      calls.push('teaches');
      const ask = JSON.parse(user) as { source: { name: string }; categories: Array<{ id: string; excerpts: string[] }> };
      return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: (opts.mentions ?? []).some((u) => ask.source.name.includes(u)) ? 'mentions' : 'teaches', evidence: c.excerpts[0]!.slice(10, 80) })) });
    }
    if (/MAIN SUBJECT/.test(system)) {
      calls.push('subject');
      const q = JSON.parse(user) as { page: { title: string } };
      return JSON.stringify({ answer: (opts.notSubject ?? []).some((t) => q.page.title.includes(t)) ? 'no' : 'yes' });
    }
    calls.push('verify');
    const body = JSON.parse(user) as { claims: Array<{ id: string; evidence: string }> };
    return JSON.stringify({ results: body.claims.map((c) => ({ id: c.id, answer: (opts.verifyNo ?? []).length ? 'no' : 'yes' })) });
  }) as unknown as Chat & { calls: string[] };
  chat.calls = calls;
  return chat;
}
const ledger = (cap = 1000) => { let n = 0; return { charge(k: number, label: string) { if (n + k > cap) throw new Error(`cap: ${label}`); n += k; }, spent: () => n }; };

async function setup(p: Parameters<typeof importTaxonomy>[0], coverage: Record<string, string> = { 'sql-querying': 'missing', 'testing-uat': 'missing' }) {
  await importTaxonomy(p, SLUG, TAX);
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('own-1'), SLUG, 'seed');
  const v = await libraryVersion(p);
  for (const [c, band] of Object.entries(coverage)) await p.query(`INSERT INTO category_coverage (role_slug, category_id, library_version, band, min_hits, source_ids) VALUES ($1,$2,$3,$4,3,$5::jsonb)`, [SLUG, c, v, band, JSON.stringify(band === 'thin' ? ['own-1'] : [])]);
  await reconcileGaps(p, SLUG);
}
const deps = (p: Parameters<typeof importTaxonomy>[0], search: SearchClient, chat: Chat, over: Record<string, unknown> = {}) => {
  const l = ledger();
  return { pool: p, chat, search, read: read(), budget: createBudget({ perGap: 4, batch: 20, ledger: l }), now: () => NOW, ledger: l, ...over };
};
const cands = async (p: Parameters<typeof importTaxonomy>[0], cat: string) => (await p.query(`SELECT url, status, reason, tier, draft FROM library_candidates WHERE category_id = $1 ORDER BY url`, [cat])).rows;

db('a missing category needs two sources: it stops after the first search that gives two, drafts both entries, and adds nothing to the library', async (p) => {
  await setup(p);
  const before = [await libraryVersion(p), (await p.query(`SELECT count(*)::int AS n FROM library_sources`)).rows[0].n];
  const s = setupSearch(() => ['https://good-one.example.org/sql', 'https://good-two.example.net/sql-guide']);
  const d = deps(p, s.search, model());
  const r = await runFinder(d, SLUG, ['sql-querying']);
  assert.equal(r.stopped, null);
  assert.equal(s.queries.length, 1, 'one search was enough');
  assert.equal(d.ledger.spent(), 1);
  const rows = await cands(p, 'sql-querying');
  assert.deepEqual(rows.map((x) => x.status), ['proposed', 'proposed']);
  const gap = (await p.query(`SELECT status, attempts, credits_spent FROM library_gaps WHERE category_id = 'sql-querying'`)).rows[0];
  assert.deepEqual([gap.status, gap.attempts, gap.credits_spent], ['candidates_ready', 1, 1]);
  assert.deepEqual(r.gaps[0]!.projected, 'strong');
  assert.deepEqual([await libraryVersion(p), (await p.query(`SELECT count(*)::int AS n FROM library_sources`)).rows[0].n], before, 'dry run: the library is unchanged');
});

db('a thin category needs one more source, so one passing page is enough', async (p) => {
  await setup(p, { 'sql-querying': 'thin', 'testing-uat': 'strong' });
  const s = setupSearch(() => ['https://good-one.example.org/sql', 'https://good-two.example.net/sql-guide']);
  const r = await runFinder(deps(p, s.search, model()), SLUG, ['sql-querying']);
  assert.equal(r.gaps[0]!.projected, 'strong');
  assert.equal((await cands(p, 'sql-querying')).filter((x) => x.status === 'proposed').length >= 1, true);
});

db('every page that fails is recorded with the check that failed it, and nothing that fails is drafted', async (p) => {
  await setup(p);
  const web = ['https://www.linkedin.com/posts/x', 'https://own-1.example.org/doc', 'https://gone.example.org/404', 'https://wrong-field.example.org/ds', 'https://only-mentions.example.org/blog', 'https://few-hits.example.org/post'];
  const s = setupSearch(() => web);
  const m = model({ wrongField: ['wrong-field'], mentions: ['blog'] });
  await runFinder(deps(p, s.search, m), SLUG, ['sql-querying']);
  const by = Object.fromEntries((await cands(p, 'sql-querying')).map((x) => [x.url as string, x as { status: string; reason: string; draft: unknown }]));
  assert.match(by['https://www.linkedin.com/posts/x'].reason, /not used as a source/);
  assert.match(by['https://own-1.example.org/doc'].reason, /already in the library/);
  assert.match(by['https://gone.example.org/404'].reason, /could not be opened without an account: HTTP 404/);
  assert.match(by['https://wrong-field.example.org/ds'].reason, /not written for this role/);
  assert.match(by['https://only-mentions.example.org/blog'].reason, /only mentions the skill/);
  assert.match(by['https://few-hits.example.org/post'].reason, /names it only 1 time/);
  assert.ok(Object.values(by).every((x) => x.status === 'rejected' && x.draft === null));
});

db('a page the second, stricter question refuses is rejected as only mentioning the skill', async (p) => {
  await setup(p);
  const s = setupSearch(() => ['https://good-one.example.org/sql']);
  await runFinder(deps(p, s.search, model({ verifyNo: ['x'] })), SLUG, ['sql-querying']);
  const row = (await cands(p, 'sql-querying'))[0]!;
  assert.deepEqual([row.status, /only mentions the skill/.test(row.reason)], ['rejected', true]);
});

db('a page is not screened twice when two searches return it, and the cheap checks run before the model is asked anything', async (p) => {
  await setup(p);
  const log: string[] = [];
  const m = model();
  const s = setupSearch((q) => (/guide/.test(q) ? ['https://www.linkedin.com/posts/x', 'https://own-1.example.org/doc'] : ['https://www.linkedin.com/posts/x', 'https://own-1.example.org/doc', 'https://good-one.example.org/sql']));
  await runFinder(deps(p, s.search, m, { read: read(log) }), SLUG, ['sql-querying']);
  assert.deepEqual(log, ['https://good-one.example.org/sql'], 'only the page that survived the cheap checks was opened');
  assert.equal(m.calls.filter((c) => c === 'audience').length, 1, 'and only that page reached the model');
  assert.equal((await cands(p, 'sql-querying')).filter((x) => x.url.includes('linkedin')).length, 1);
});

db('with nothing passing the finder searches twice, then two more only if the budget allows, and never a fifth time', async (p) => {
  await setup(p);
  const s = setupSearch(() => ['https://few-hits.example.org/post']);
  const d = deps(p, s.search, model());
  await runFinder(d, SLUG, ['sql-querying']);
  assert.equal(s.queries.length, 4);
  assert.equal(d.ledger.spent(), 4);
  const gap = (await p.query(`SELECT status, credits_spent, note FROM library_gaps WHERE category_id = 'sql-querying'`)).rows[0];
  assert.deepEqual([gap.status, gap.credits_spent], ['open', 4]);
  assert.match(gap.note, /no page passed/);
});

db('the batch limit stops the run before a search that would pass it, and says which gaps were not tried; a gap does not spend what the other gaps need', async (p) => {
  await setup(p);
  const s = setupSearch(() => ['https://few-hits.example.org/post']);
  const r = await runFinder(deps(p, s.search, model(), { budget: createBudget({ perGap: 4, batch: 3, ledger: ledger() }) }), SLUG, ['sql-querying', 'testing-uat']);
  // each gap is owed two searches before any gets a third: the first gap stops at two, the second gets one and then the limit
  assert.equal(r.stopped, 'batch');
  assert.equal(s.queries.length, 3);
  assert.deepEqual(r.notTried, []);
  const credits = Object.fromEntries((await p.query(`SELECT category_id, credits_spent FROM library_gaps`)).rows.map((x) => [x.category_id, x.credits_spent]));
  assert.deepEqual(credits, { 'sql-querying': 2, 'testing-uat': 1 });

  const l2 = ledger();
  const s2 = setupSearch(() => ['https://few-hits.example.org/post']);
  const r2 = await runFinder(deps(p, s2.search, model(), { budget: createBudget({ perGap: 4, batch: 2, ledger: l2 }) }), SLUG, ['sql-querying', 'testing-uat']);
  assert.equal(r2.stopped, 'batch');
  assert.deepEqual(r2.notTried, ['testing-uat']);
  assert.equal(l2.spent(), 2);
});

db('the ledger\'s own cap stops the run too and is reported as such; a failed search leaves what it found so far', async (p) => {
  await setup(p);
  const s = setupSearch(() => ['https://good-one.example.org/sql']);
  const r = await runFinder(deps(p, s.search, model(), { budget: createBudget({ perGap: 4, batch: 20, ledger: ledger(0) }) }), SLUG, ['sql-querying']);
  assert.equal(r.stopped, 'ledger');
  assert.equal(s.queries.length, 0);
  const failing: SearchClient = { search: async () => { throw new Error('search down'); } };
  const r3 = await runFinder(deps(p, failing, model()), SLUG, ['testing-uat']);
  assert.equal(r3.stopped, null);
  assert.match((await p.query(`SELECT note FROM library_gaps WHERE category_id = 'testing-uat'`)).rows[0].note, /no page passed/);
});

db('a drafted entry passes the library check as it stands, is for this role, active, link-only, with its decision recorded, and has a tier from its publisher', async (p) => {
  await setup(p);
  const s = setupSearch(() => ['https://good-one.example.org/sql', 'https://good-two.example.net/sql-guide']);
  await runFinder(deps(p, s.search, model()), SLUG, ['sql-querying']);
  const drafts = (await cands(p, 'sql-querying')).map((x) => x.draft as LibrarySource);
  assert.equal(drafts.length, 2);
  assert.equal(new Set(drafts.map((d) => d.id)).size, 2, 'ids are unique');
  for (const d of drafts) {
    assert.deepEqual(validateLibrary({ shared: [], roles: { [SLUG]: { role: SLUG, built: '', sources: [d], uses_shared: [], checked_and_excluded: [] } } }, { today: NOW }).errors, [], d.id);
    assert.deepEqual([d.applies_to, d.status, d.access, d.pipeline_readable, d.tier], [[SLUG], 'active', 'open', true, 3]);
    assert.match(String(d.citation_policy), /link/i);
    assert.match(String(d.decision_note), /finder/i);
    assert.equal(d.last_verified.date, '2026-10-20');
    assert.ok(d.next_check > '2026-10-20');
  }
});

db('the search sees only the category and the role: nothing from a posting, and job boards are excluded from the results', async (p) => {
  await setup(p);
  const s = setupSearch(() => []);
  await runFinder(deps(p, s.search, model()), SLUG, ['sql-querying']);
  assert.ok(s.queries.length >= 2);
  const allowed = new Set([...TAX.categories[0]!.name.split(' '), ...TAX.categories[0]!.aliases.flatMap((a) => a.split(' ')), ...TAX.categories[0]!.description.split(' '), ...TAX.role.split(' '), ...'for a guide and best practices tutorial explained introduction standard handbook'.split(' ')].map((w) => w.toLowerCase()));
  for (const q of s.queries) {
    assert.ok(q.query.toLowerCase().replace(/[:,]/g, '').split(' ').every((w) => allowed.has(w)), `only category, role and generic words: ${q.query}`);
    assert.ok(q.excludeDomains?.includes('linkedin.com') && q.excludeDomains.includes('indeed.com'));
  }
});

db('the teaches check: too few mentions are not sent to the model; enough mentions go through both questions', async (p) => {
  const m = model();
  const cat = { id: 'sql-querying', name: 'SQL querying', description: 'writing queries', aliases: ['sql'] };
  const few = await teachesCheck(m, { name: 'x', why: 'y' }, 'a text that says SQL once', cat, 3);
  assert.deepEqual([few.status, few.hits], ['few', 1]);
  assert.equal(m.calls.length, 0);
  const many = await teachesCheck(m, { name: 'x', why: 'y' }, 'SQL here, SQL there, and more SQL in a long explanation of SQL queries', cat, 3);
  assert.equal(many.status, 'teaches');
  assert.ok(many.evidence.length >= 40);
  assert.deepEqual(m.calls, ['teaches', 'verify']);
  const down = await teachesCheck((async () => { throw new Error('down'); }) as Chat, { name: 'x', why: 'y' }, 'SQL SQL SQL SQL', cat, 3);
  assert.equal(down.status, 'unchecked', 'an unavailable model is never read as a pass');
});

db('a document from a publisher we cannot confirm owns it is not offered, but the same kind of document from an institution is', async (p) => {
  await setup(p);
  const read2 = async (s: { id: string; url: string }) => (WEB[s.url] ? ({ ok: true as const, id: s.id, text: WEB[s.url]!, kind: s.url.endsWith('.pdf') ? ('pdf' as const) : ('html' as const) }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
  WEB['https://school.edu/notes.pdf'] = WEB['https://pdf-copy.example.org/book.pdf']!;
  const s = setupSearch(() => ['https://pdf-copy.example.org/book.pdf', 'https://school.edu/notes.pdf']);
  await runFinder(deps(p, s.search, model(), { read: read2 }), SLUG, ['sql-querying']);
  const by = Object.fromEntries((await cands(p, 'sql-querying')).map((x) => [x.url as string, x as { status: string; reason: string }]));
  assert.equal(by['https://pdf-copy.example.org/book.pdf']!.status, 'rejected');
  assert.match(by['https://pdf-copy.example.org/book.pdf']!.reason, /publisher we cannot confirm/);
  assert.equal(by['https://school.edu/notes.pdf']!.status, 'proposed');
});

db('the skill has to be the page\'s main subject: a list of tips that names it among many things is turned away even when it passes the other questions', async (p) => {
  await setup(p);
  const m = model({ notSubject: ['best-practices'] });
  const s = setupSearch(() => ['https://list-post.example.org/best-practices', 'https://good-one.example.org/sql']);
  await runFinder(deps(p, s.search, m), SLUG, ['sql-querying']);
  const by = Object.fromEntries((await cands(p, 'sql-querying')).map((x) => [x.url as string, x as { status: string; reason: string }]));
  assert.match(by['https://list-post.example.org/best-practices']!.reason, /not the main subject/);
  assert.equal(by['https://good-one.example.org/sql']!.status, 'proposed');
  assert.ok(m.calls.includes('subject'));
});
