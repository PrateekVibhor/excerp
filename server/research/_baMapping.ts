/** Read-only (not committed): maps every phrase the real business analyst postings used to a category, with the real model; prints and writes research/out/ba-mapping.md. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { loadTaxonomy, validateTaxonomy } from '../src/courses/taxonomy/taxonomy.ts';
import { mapPhrases } from '../src/courses/taxonomy/map.ts';
const here = new URL('.', import.meta.url).pathname;
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run -c default_transaction_read_only=on' });
const t = loadTaxonomy(`${here}../reference-library/business-analyst/categories.json`);
console.log('taxonomy errors:', validateTaxonomy(t));
const rows = (await pool.query(`SELECT k.name, k.kind, k.mentions, k.terms FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id JOIN courses c ON c.id = cc.course_id JOIN roles r ON r.id = c.role_id WHERE r.name = 'business analyst' ORDER BY k.mentions DESC`)).rows as Array<{ name: string; kind: string; mentions: number; terms: string[] }>;
const phrases = [...new Set(rows.flatMap((r) => [r.name, ...r.terms]))];
const r = await mapPhrases(chat, t, phrases);
const byPhrase = new Map(r.mapped.map((m) => [m.phrase.toLowerCase().replace(/\s+/g, ' '), m]));
const nameOf = (id: string | null) => (id === null ? '(unmapped)' : id.startsWith('new:') ? `NEW: ${r.proposals.find((p) => `new:${p.id}` === id)?.name}` : t.categories.find((c) => c.id === id)?.name ?? id);
const out: string[] = ['# Business analyst: posting phrases -> categories\n', `${phrases.length} distinct phrases from the ${rows.length} concepts of the 10 real postings; tokens ${tokens.in} in / ${tokens.out} out.\n`];
for (const c of rows) {
  out.push(`\n**${c.name}** (${c.kind}, in ${c.mentions} postings)`);
  for (const p of [c.name, ...c.terms.filter((x) => x !== c.name)]) {
    const m = byPhrase.get(p.toLowerCase().replace(/\s+/g, ' '))!;
    out.push(`- ${p}  ->  ${nameOf(m.category)}  [${m.source}]${m.tools.length ? `  tool: ${m.tools.join(', ')}` : ''}`);
  }
}
const count = (s: string) => r.mapped.filter((m) => m.source === s).length;
out.push(`\n## Totals\nalias ${count('alias')}, tool ${count('tool')}, model ${count('model')}, proposed ${count('proposed')}, unmapped ${count('unmapped')}`);
out.push(`\nProposed categories: ${r.proposals.map((p) => `${p.name} (${p.phrases.length})`).join('; ') || 'none'}`);
const perCat = new Map<string, number>(); for (const m of r.mapped) perCat.set(nameOf(m.category), (perCat.get(nameOf(m.category)) ?? 0) + 1);
out.push(`\nPhrases per category: ${[...perCat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('; ')}`);
writeFileSync(`${here}out/ba-mapping.md`, out.join('\n'));
console.log(out.join('\n'));
await pool.end();
