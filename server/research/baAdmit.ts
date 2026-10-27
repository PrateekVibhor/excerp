/** Business analyst: admit the finder's proposed pages (two independent runs), rate the new library version, reconcile the gap queue. p4_run only. No search, no Tavily. Not committed. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';
import { libraryVersion } from '../src/courses/library/db.ts';
import { admitAndRate } from '../src/courses/gaps/admit.ts';
import { loadTaxonomyFromDb } from '../src/courses/taxonomy/db.ts';
const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
try {
  const tax = (await loadTaxonomyFromDb(pool, SLUG))!;
  const v0 = await libraryVersion(pool);
  const bands = async (v: number) => Object.fromEntries((await pool.query(`SELECT category_id, band, source_ids FROM category_coverage WHERE role_slug = $1 AND library_version = $2`, [SLUG, v])).rows.map((r) => [r.category_id, `${r.band}`]));
  const before = await bands(v0);
  const r = await admitAndRate({ pool, chat, read: fetchSourceText }, SLUG);
  const v1 = await libraryVersion(pool);
  const after = r.coverage.ok ? await bands(r.coverage.version) : {};
  const out = [`# Admission, business analyst (p4_run)\n`, `library version ${v0} -> ${v1}; admitted ${r.admission.admitted.length}: ${r.admission.admitted.join(', ')}; kept proposed ${r.admission.kept.length}; model tokens ${tokens.in} in / ${tokens.out} out; no search credits\n`];
  for (const k of r.admission.kept) out.push(`- failed the second run [${k.category}] <${k.url}>: ${k.reason}`);
  out.push('\n| Category | before (v' + v0 + ') | after (v' + v1 + ') |', '|---|---|---|');
  for (const c of tax.categories) out.push(`| ${c.name} | ${before[c.id] ?? '-'} | ${after[c.id] ?? '-'}${before[c.id] !== after[c.id] ? ' **changed**' : ''} |`);
  const gaps = (await pool.query(`SELECT category_id, status, filled_version FROM library_gaps WHERE role_slug = $1 ORDER BY category_id`, [SLUG])).rows;
  out.push('\nGaps: ' + gaps.map((g) => `${g.category_id}=${g.status}${g.filled_version ? `@v${g.filled_version}` : ''}`).join(', '));
  const changes = (await pool.query(`SELECT version, kind, source_id FROM library_changes WHERE version > $1 ORDER BY version`, [v0])).rows;
  out.push('\nlibrary_changes: ' + changes.map((c) => `v${c.version} ${c.kind} ${c.source_id}`).join('; '));
  if (r.coverage.ok) out.push(`\nrating at v${r.coverage.version}: strong ${r.coverage.summary.strong}, thin ${r.coverage.summary.thin}, missing ${r.coverage.summary.missing}, unjudged ${r.coverage.summary.unverified}`);
  else out.push(`\nrating could not be made: unread sources ${r.coverage.unindexed.join(', ')}`);
  writeFileSync(`${here}out/ba-admission.md`, out.join('\n'));
  console.log(out.join('\n'));
} finally {
  await pool.end();
}
