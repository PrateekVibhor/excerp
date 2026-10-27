/**
 * R2 step 1 (plan 16, phase 3): reference text for the R2 chapters. The owner allowed about 40 credits for this, charged to the R0 ledger
 * (not the 60-credit R2 cap, which is kept for the QA agent's extra searches). One basic search per chapter concept, the top 8 concepts by
 * mentions in each of five roles. Writes out/r2/concepts.json (the chapter plan) and out/r2/sources-<role>.json.
 *   node --env-file=.env research/r2Sources.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CapReached, openLedger } from './creditLedger.ts';

const here = new URL('.', import.meta.url).pathname;
const ROLES = ['backend software engineer', 'ML engineer', 'forward-deployed engineer', 'project manager']; // core roles added after the scope change; product manager, business analyst and data analyst are already done
const PER_ROLE = 8;
const ALLOWANCE = 40; // owner-approved; quality over a tight cap
const slug = (role: string) => role.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const ledger = openLedger(`${here}out/ledger.json`, { phase: 'R2ref', cap: 80 });
const start = ledger.spent();
const key = process.env.TAVILY_API_KEY!.trim();

const plan = ROLES.map((role) => {
  const ranked = JSON.parse(readFileSync(`${here}out/r0-${slug(role)}.json`, 'utf8')).ranked as Array<{ skill: string; mentions: number; band: string }>;
  return { role, concepts: ranked.slice(0, PER_ROLE) };
});
const existing = existsSync(`${here}out/r2/concepts.json`) ? (JSON.parse(readFileSync(`${here}out/r2/concepts.json`, 'utf8')) as typeof plan) : [];
writeFileSync(`${here}out/r2/concepts.json`, `${JSON.stringify([...existing.filter((e) => !plan.some((p) => p.role === e.role)), ...plan], null, 1)}\n`);

outer: for (const { role, concepts } of plan) {
  const file = `${here}out/r2/sources-${slug(role)}.json`;
  const done: Record<string, Array<{ url: string; title: string; text: string }>> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const c of concepts) {
    if (done[c.skill]) continue;
    if (ledger.spent() - start + 1 > ALLOWANCE) { console.log('allowance reached'); break outer; }
    try { ledger.charge(1, `R2 reference: ${role} / ${c.skill}`); } catch (e) { if (e instanceof CapReached) { console.log(e.message); break outer; } throw e; }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `${c.skill} for a ${role}: explanation and best practices`, search_depth: 'basic', max_results: 4, include_raw_content: 'text', include_answer: false }),
    });
    if (!res.ok) { console.log(role, c.skill, 'failed', res.status); continue; }
    const json = (await res.json()) as { results?: Array<{ url: string; title: string; raw_content?: string; content?: string }> };
    done[c.skill] = (json.results ?? []).map((r) => ({ url: r.url, title: r.title, text: (r.raw_content ?? r.content ?? '').slice(0, 6000) }));
    writeFileSync(file, `${JSON.stringify(done, null, 1)}\n`);
  }
  console.log(role, Object.keys(done).length, 'concepts with sources');
}
console.log(`spent here ${ledger.spent() - start} (allowance ${ALLOWANCE}); ${ledger.summary()}`);
