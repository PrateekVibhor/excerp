/**
 * Source finder, DRY RUN, for the business analyst library (plan 16, part 6), against the p4_run schema. Searches the web with Tavily (one credit a search,
 * charged to the separate BA ledger, cap 200 with 50 in reserve), screens what it finds with the same teaches-not-mentions check coverage uses, and
 * records the candidates. Nothing is added to the library. Not committed.
 *   node --env-file=.env research/baFinder.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { createTavily } from '../src/courses/pipeline/clients.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';
import { libraryVersion } from '../src/courses/library/db.ts';
import { createBudget } from '../src/courses/gaps/budget.ts';
import { runFinder } from '../src/courses/gaps/finder.ts';
import { gapsOf, reconcileGaps } from '../src/courses/gaps/gaps.ts';
import { loadTaxonomyFromDb } from '../src/courses/taxonomy/db.ts';
import { CapReached, openLedger } from './creditLedger.ts';

const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const TEN = ['data-analysis', 'sql-data-querying', 'reporting-kpis-dashboards', 'spreadsheet-analysis', 'testing-uat', 'change-management', 'project-coordination', 'communication-presentation', 'enterprise-systems-analysis', 'domain-knowledge'];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const ledger = openLedger(`${here}out/ba-ledger.json`, { phase: 'BA', cap: 200, reserve: 50 });
const tavily = createTavily(process.env.TAVILY_API_KEY!.trim());
try {
  await pool.query(readFileSync(`${here}../migrations/014_library_gaps.sql`, 'utf8'));
  console.log('reconcile:', await reconcileGaps(pool, SLUG), '| library version', await libraryVersion(pool), '|', ledger.summary());
  const before = (await pool.query(`SELECT count(*)::int AS n FROM library_sources`)).rows[0].n;
  const budget = createBudget({ perGap: 4, batch: 20, ledger: { charge: (n, label) => { ledger.charge(n, label); console.log(`  search: ${label}`); } } });
  const r = await runFinder({ pool, chat, search: tavily, read: fetchSourceText, budget }, SLUG, TEN);
  const tax = (await loadTaxonomyFromDb(pool, SLUG))!;
  const name = (id: string) => tax.categories.find((c) => c.id === id)?.name ?? id;
  const out: string[] = [`# Source finder dry run, business analyst\n`, `${ledger.summary()}; batch credits ${budget.spentInBatch()} of 20; stopped: ${r.stopped ?? 'no'}; not tried: ${r.notTried.join(', ') || 'none'}; model tokens ${tokens.in} in / ${tokens.out} out; library sources before/after ${before}/${(await pool.query(`SELECT count(*)::int AS n FROM library_sources`)).rows[0].n} (dry run: unchanged)\n`];
  for (const g of r.gaps) {
    out.push(`\n## ${name(g.category)}: ${g.passed} passed, ${g.rejected} rejected, ${g.credits} credits, would be ${g.projected}${g.note ? ` (${g.note})` : ''}`);
    for (const c of (await pool.query(`SELECT url, name, status, reason, tier, draft FROM library_candidates WHERE role_slug = $1 AND category_id = $2 ORDER BY status DESC, url`, [SLUG, g.category])).rows) {
      out.push(`- ${c.status === 'proposed' ? 'PASS' : 'fail'} tier ${c.tier ?? '-'} ${c.name.slice(0, 70)} <${c.url}>: ${c.reason}${c.draft ? `\n    evidence: ${c.draft.decision_note.replace(/^.*evidence: /, '').slice(0, 200)}` : ''}`);
    }
  }
  const tally = (await pool.query(`SELECT status, count(*)::int AS n FROM library_candidates WHERE role_slug = $1 GROUP BY 1`, [SLUG])).rows;
  const why = (await pool.query(`SELECT regexp_replace(reason, '[:(].*$', '') AS reason, count(*)::int AS n FROM library_candidates WHERE role_slug = $1 AND status = 'rejected' GROUP BY 1 ORDER BY 2 DESC`, [SLUG])).rows;
  out.push(`\n## Totals\n${JSON.stringify(tally)}\nRejected because: ${why.map((w) => `${w.reason.trim()} ${w.n}`).join('; ')}`);
  writeFileSync(`${here}out/ba-finder-dryrun.md`, out.join('\n'));
  console.log(out.join('\n'));
  console.log('gaps:', (await gapsOf(pool, SLUG)).map((g) => `${g.category_id}=${g.status}`).join(' '));
} catch (error) {
  console.log(error instanceof CapReached ? `STOPPED: ${error.message}` : `FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
