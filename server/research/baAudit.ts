/** Business analyst, p4_run only: apply the coverage-verdict gate to the sources the finder already admitted, remove the ones the rating does not count, and rate again. No search, no Tavily. Not committed. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';
import { libraryVersion } from '../src/courses/library/db.ts';
import { auditAndRate } from '../src/courses/gaps/admit.ts';
import { loadTaxonomyFromDb } from '../src/courses/taxonomy/db.ts';
const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
try {
  const tax = (await loadTaxonomyFromDb(pool, SLUG))!;
  const v0 = await libraryVersion(pool);
  const bands = async (v: number) => Object.fromEntries((await pool.query(`SELECT category_id, band FROM category_coverage WHERE role_slug = $1 AND library_version = $2`, [SLUG, v])).rows.map((r) => [r.category_id, r.band as string]));
  const before = await bands(v0);
  const finder = (await pool.query(`SELECT s.id, s.status, c.category_id, (SELECT verdict FROM library_source_categories l WHERE l.source_id = s.id AND l.category_id = c.category_id) AS stored FROM library_sources s JOIN library_candidates c ON c.draft->>'id' = s.id WHERE s.origin = 'finder' ORDER BY s.id`)).rows;
  const r = await auditAndRate({ pool, chat, read: fetchSourceText }, SLUG);
  const v1 = await libraryVersion(pool);
  const after = r.coverage.ok ? await bands(r.coverage.version) : {};
  const out = [`# Coverage-verdict gate, applied to the admitted sources (p4_run)\n`, `library version ${v0} -> ${v1}; removed ${r.removed.length}; model tokens ${tokens.in} in / ${tokens.out} out; no search credits\n`, 'Finder-admitted sources before the audit (category admitted for, stored verdict):', ...finder.map((f) => `- ${f.id} [${f.category_id}] stored: ${f.stored}`), '', ...r.removed.map((x) => `REMOVED ${x.id} [${x.category}]: ${x.reason}`)];
  out.push('\n| Category | before (v' + v0 + ') | after (v' + v1 + ') |', '|---|---|---|');
  for (const c of tax.categories) out.push(`| ${c.name} | ${before[c.id] ?? '-'} | ${after[c.id] ?? '-'}${before[c.id] !== after[c.id] ? ' **changed**' : ''} |`);
  out.push('\nlibrary_changes: ' + (await pool.query(`SELECT version, kind, source_id, summary FROM library_changes WHERE version > $1 ORDER BY version`, [v0])).rows.map((c) => `v${c.version} ${c.kind} ${c.source_id} (${c.summary.slice(0, 90)})`).join('; '));
  out.push('\nGaps: ' + (await pool.query(`SELECT category_id, status, filled_version FROM library_gaps WHERE role_slug = $1 ORDER BY category_id`, [SLUG])).rows.map((g) => `${g.category_id}=${g.status}${g.filled_version ? `@v${g.filled_version}` : ''}`).join(', '));
  if (r.coverage.ok) out.push(`\nrating at v${r.coverage.version}: strong ${r.coverage.summary.strong}, thin ${r.coverage.summary.thin}, missing ${r.coverage.summary.missing}, unjudged ${r.coverage.summary.unverified}`);
  writeFileSync(`${here}out/ba-audit.md`, out.join('\n'));
  console.log(out.join('\n'));
} finally {
  await pool.end();
}
