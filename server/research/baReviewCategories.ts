/**
 * Review of the phrases the business analyst skill categories could not place (read-only: nothing is written to the database). The corpus is the unplaced concepts of the
 * treasury-systems posting build and the unplaced or proposed phrases of the two held-out posting mappings. Writes research/out/ba-category-review.md. Not committed.
 *   node --env-file=.env research/baReviewCategories.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { loadTaxonomyFromDb } from '../src/courses/taxonomy/db.ts';
import { reviewUnplaced } from '../src/courses/taxonomy/review.ts';
const here = new URL('.', import.meta.url).pathname;
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run -c default_transaction_read_only=on' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
try {
  const tax = (await loadTaxonomyFromDb(pool, 'business-analyst'))!;
  const fromBuild = (await pool.query(`SELECT k.name, k.terms FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id JOIN courses c ON c.id = cc.course_id WHERE c.visibility = 'private' AND cc.skill_category IS NULL AND cc.from_reader_source`)).rows as Array<{ name: string; terms: string[] }>;
  const first = fromBuild.flatMap((r) => [r.name, ...r.terms]);
  const fromFiles = ['ba-mapping-holdout-v2.md', 'ba-mapping-fresh.md'].flatMap((f) => readFileSync(`${here}out/${f}`, 'utf8').split('\n').filter((l) => /\[(unmapped|proposed)\]/.test(l)).map((l) => l.split('|')[1]!.trim()));
  const phrases = [...new Map([...first, ...fromFiles].map((p) => [p.toLowerCase(), p])).values()];
  const r = await reviewUnplaced(chat, tax, phrases);
  const name = (id: string) => tax.categories.find((c) => c.id === id)?.name ?? id;
  const out = [`# Unplaced phrases: review (${new Date().toISOString().slice(0, 10)})\n`, `${phrases.length} distinct phrases (${first.length} from the treasury-systems posting build, the rest from the held-out posting mappings); model tokens ${tokens.in} in / ${tokens.out} out. Nothing was written.\n`];
  out.push(`## Proposed new categories (${r.proposals.length})\n`);
  for (const p of r.proposals) out.push(`### ${p.name}  [${p.verified === 'not_covered' ? 'a second check found no existing category for these phrases' : 'second check unavailable'}]\n- covers: ${p.description}\n- aliases: ${p.aliases.join(', ') || '(none)'}\n- phrases (${p.phrases.length}): ${p.phrases.join(' | ')}\n- nearest existing: ${name(p.nearest)}; why it does not fit: ${p.whyNotNearest}\n`);
  out.push(`## Now placed in an existing category (${r.fits.length})\n`, ...r.fits.map((f) => `- ${f.phrase} -> ${f.categories.map(name).join(' + ')}`));
  out.push(`\n## Not skills (${r.notSkills.length})\n`, r.notSkills.join(' | ') || '(none)');
  out.push(`\n## Left unassigned (${r.unassigned.length})\n`, r.unassigned.join(' | ') || '(none)');
  writeFileSync(`${here}out/ba-category-review.md`, out.join('\n'));
  console.log(out.join('\n'));
} finally {
  await pool.end();
}
