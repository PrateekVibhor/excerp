/**
 * The business analyst library in the database (plan 16, part 5), run against the p4_run schema. No Tavily credits and no model calls: it only reads the
 * library's pages. Not committed.
 *   node --env-file=.env research/baLibrary.ts setup     apply migration 013 and import the library and the skill categories from the files
 *   node --env-file=.env research/baLibrary.ts refresh   read the sources that are new or changed, rate every category, print the ratings
 *   node --env-file=.env research/baLibrary.ts history   the ratings by library version
 *   node --env-file=.env research/baLibrary.ts export    write the database's library back to reference-library/snapshot/ (backup and audit)
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { exportLibrary, importLibrary, libraryVersion } from '../src/courses/library/db.ts';
import { coverageHistory, refreshCoverage } from '../src/courses/coverage/coverage.ts';
import { createNebiusChat } from '../src/llm.ts';
import { exportTaxonomy, importTaxonomy, loadTaxonomyFromDb } from '../src/courses/taxonomy/db.ts';
import { loadTaxonomy } from '../src/courses/taxonomy/taxonomy.ts';

const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const tokens = { in: 0, out: 0 };
const chat = () => createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
try {
  const [command] = process.argv.slice(2);
  if (command === 'setup') {
    await pool.query(readFileSync(`${here}../migrations/013_library_db.sql`, 'utf8'));
    console.log('library import:', await importLibrary(pool, `${here}../reference-library`, [SLUG]));
    await importTaxonomy(pool, SLUG, loadTaxonomy(`${here}../reference-library/business-analyst/categories.json`));
    console.log('library version', await libraryVersion(pool));
  } else if (command === 'refresh') {
    const r = await refreshCoverage(pool, SLUG, undefined, chat());
    if (!r.ok) throw new Error(`unread sources: ${r.unindexed.join(', ')}`);
    const t = (await loadTaxonomyFromDb(pool, SLUG))!;
    const name = (id: string) => t.categories.find((c) => c.id === id)?.name ?? id;
    console.log(`library version ${r.version}: strong ${r.summary.strong}, thin ${r.summary.thin}, missing ${r.summary.missing} of ${r.summary.total}; unjudged links ${r.summary.unverified}; not readable by the pipeline: ${r.summary.unreadable.join(', ') || 'none'}; judge tokens ${tokens.in} in / ${tokens.out} out\n`);
    const v = (await pool.query(`SELECT verdict, count(*)::int AS n FROM library_source_categories WHERE hits >= 3 GROUP BY 1 ORDER BY 1`)).rows;
    console.log('links with 3+ mentions by verdict:', JSON.stringify(v), '\n');
    for (const band of ['strong', 'thin', 'missing'] as const) {
      console.log(`${band.toUpperCase()}`);
      for (const row of r.rows.filter((x) => x.band === band)) console.log(`  ${name(row.category)}${row.sources.length ? `  <- ${row.sources.join(', ')}` : ''}`);
    }
  } else if (command === 'history') {
    for (const h of await coverageHistory(pool, SLUG)) console.log(`version ${h.version}: strong ${h.strong}, thin ${h.thin}, missing ${h.missing}  (${h.computed_at.toISOString()})`);
  } else if (command === 'export') {
    const files = await exportLibrary(pool, `${here}../reference-library/snapshot`);
    files.push(await exportTaxonomy(pool, SLUG, `${here}../reference-library/snapshot`));
    console.log(files.join('\n'));
  } else console.log('usage: baLibrary.ts setup | refresh | history | export');
} finally {
  await pool.end();
}
