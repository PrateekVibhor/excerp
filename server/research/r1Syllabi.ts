/**
 * R1 syllabus retrieval (plan 16, phase 3): one basic Tavily search per role for published course syllabi (1 credit each, ledger phase R1, cap 30).
 *   node --env-file=.env research/r1Syllabi.ts "product manager" ...
 * Writes research/out/r1/syllabi-<role>.json.
 */
import { writeFileSync } from 'node:fs';
import { CapReached, openLedger } from './creditLedger.ts';

const here = new URL('.', import.meta.url).pathname;
const slug = (role: string) => role.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const ledger = openLedger(`${here}out/ledger.json`, { phase: 'R1', cap: 30 });
const key = process.env.TAVILY_API_KEY!.trim();

for (const role of process.argv.slice(2)) {
  try {
    ledger.charge(1, `syllabus search: ${role}`);
  } catch (error) {
    if (error instanceof CapReached) { console.log(error.message); break; }
    throw error;
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `${role} course syllabus curriculum modules in order`, search_depth: 'basic', max_results: 5, include_raw_content: 'text', include_answer: false }),
  });
  if (!res.ok) { console.log(role, 'search failed', res.status); continue; }
  const json = (await res.json()) as { results?: Array<{ url: string; title: string; raw_content?: string; content?: string }> };
  const results = (json.results ?? []).map((r) => ({ url: r.url, title: r.title, text: (r.raw_content ?? r.content ?? '').slice(0, 8000) }));
  writeFileSync(`${here}out/r1/syllabi-${slug(role)}.json`, `${JSON.stringify({ role, date: new Date().toISOString(), results }, null, 1)}\n`);
  console.log(role, results.length, 'results');
}
console.log(ledger.summary());
