/** Not committed. Re-screens the finder's earlier PASSING candidates with the current rules, at no search cost (no Tavily; pages are re-opened and re-judged). Gap counters are restored afterwards. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';
import { createBudget } from '../src/courses/gaps/budget.ts';
import { runFinder } from '../src/courses/gaps/finder.ts';
const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const saved = (await pool.query(`SELECT category_id, status, attempts, credits_spent, note FROM library_gaps WHERE role_slug = $1`, [SLUG])).rows;
const cats = (await pool.query(`SELECT DISTINCT category_id FROM library_candidates WHERE role_slug = $1 AND status = 'proposed'`, [SLUG])).rows.map((r) => r.category_id as string);
const out: string[] = [];
for (const c of cats) {
  const prev = (await pool.query(`SELECT url, name FROM library_candidates WHERE role_slug = $1 AND category_id = $2 AND status = 'proposed'`, [SLUG, c])).rows;
  const search = { search: async () => prev.map((r) => ({ url: r.url as string, title: r.name as string, text: '' })) };
  await runFinder({ pool, chat, search, read: fetchSourceText, budget: createBudget({ perGap: 1, batch: 1, ledger: { charge: () => {} } }) }, SLUG, [c]);
  for (const r of prev) {
    const now = (await pool.query(`SELECT status, reason FROM library_candidates WHERE role_slug = $1 AND category_id = $2 AND url = $3`, [SLUG, c, r.url])).rows[0];
    out.push(`${now.status === 'proposed' ? 'PASS' : 'drop'} [${c}] ${r.name.slice(0, 60)} <${r.url}>${now.status === 'proposed' ? '' : `: ${now.reason}`}`);
  }
}
for (const g of saved) await pool.query(`UPDATE library_gaps SET status = $3, attempts = $4, credits_spent = $5, note = $6 WHERE role_slug = $1 AND category_id = $2`, [SLUG, g.category_id, g.status, g.attempts, g.credits_spent, g.note]);
out.push(`\nmodel tokens ${tokens.in} in / ${tokens.out} out; no search credits used`);
writeFileSync(`${here}out/ba-finder-rescreen.md`, out.join('\n'));
console.log(out.join('\n'));
await pool.end();
