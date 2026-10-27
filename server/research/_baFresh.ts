/** Not committed: fresh business analyst postings (not used to build the taxonomy) -> skills -> categories, to test the mapper on unseen wording. Uses the separate BA ledger (cap 200). */
import { writeFileSync } from 'node:fs';
import { createNebiusChat } from '../src/llm.ts';
import { createTavily } from '../src/courses/pipeline/clients.ts';
import { readPosting } from '../src/courses/pipeline/read.ts';
import { loadTaxonomy } from '../src/courses/taxonomy/taxonomy.ts';
import { mapPhrases } from '../src/courses/taxonomy/map.ts';
import { openLedger } from './creditLedger.ts';
const here = new URL('.', import.meta.url).pathname;
const ledger = openLedger(`${here}out/ba-ledger.json`, { phase: 'BA', cap: 200 });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const tavily = createTavily(process.env.TAVILY_API_KEY!.trim());
const SET2 = ['business analyst requirements gathering UAT job posting insurance', 'business analyst job description Workday HRIS implementation', 'IT business analyst job posting agile Jira user stories', 'business analyst retail e-commerce job posting analytics', 'business analyst AI automation process improvement job posting', 'lead business analyst government public sector job posting requirements'];
const queries = process.env.SET2 ? SET2 : ['business analyst job description responsibilities qualifications', 'business analyst job posting AI tools prompt generative AI requirements', 'senior business analyst ERP SAP Oracle job description', 'business analyst healthcare job posting requirements', 'business analyst banking financial services job posting requirements', 'business analyst SQL Power BI Tableau data analysis job description'];
const pages = new Map<string, { title: string; text: string }>();
for (const q of queries) {
  ledger.charge(1, `ba-fresh: ${q.slice(0, 50)}`);
  for (const h of await tavily.search({ query: q, maxResults: 6 })) if (/responsib|qualif|requirements/i.test(h.text) && h.text.length > 1200) pages.set(h.url, { title: h.title, text: h.text });
}
console.log(`${pages.size} candidate postings`);
const phrases: string[] = []; const per: string[] = [];
for (const [url, p] of pages) {
  const r = await readPosting(chat, `${p.title}\n${p.text}`.slice(0, 9000));
  if (!r) continue;
  per.push(`${p.title.slice(0, 60)} (${url.slice(0, 60)}): ${r.skills.length} skills, ${r.scenarios.length} scenarios`);
  phrases.push(...r.skills, ...r.scenarios);
}
const t = loadTaxonomy(`${here}../reference-library/business-analyst/categories.json`);
const bare = { ...t, categories: t.categories.map((c) => ({ ...c, aliases: [] })) }; // model only: no aliases, to test unseen wording
const full = await mapPhrases(chat, t, phrases);
const modelOnly = process.env.SET2 ? full : await mapPhrases(chat, bare, phrases);
const nm = (tx: typeof t, r: typeof full, id: string) => (id.startsWith('new:') ? `NEW ${r.proposals.find((p) => `new:${p.id}` === id)?.name}` : tx.categories.find((c) => c.id === id)?.name ?? id);
const bymodel = new Map(modelOnly.mapped.map((m) => [m.phrase, m]));
const out = [`# Fresh BA postings -> categories\n`, ...per.map((x) => `- ${x}`), `\n${full.mapped.length} distinct phrases; tokens ${tokens.in}/${tokens.out}; sources: ${JSON.stringify(Object.fromEntries(['alias', 'tool', 'model', 'proposed', 'unmapped'].map((s) => [s, full.mapped.filter((m) => m.source === s).length])))}\n`, '| phrase | with aliases | model only | tool |', '|---|---|---|---|'];
let agree = 0;
for (const m of full.mapped) { const o = bymodel.get(m.phrase)!; const a = m.categories.map((c) => nm(t, full, c)).join(' + ') || '(none)'; const b = o.categories.map((c) => nm(bare, modelOnly, c)).join(' + ') || '(none)'; if (m.categories[0] === o.categories[0]) agree++; out.push(`| ${m.phrase} | ${a} [${m.source}] | ${b} | ${m.tools.join(', ')} |`); }
out.push(`\nPrimary category agrees between alias-assisted and model-only: ${agree}/${full.mapped.length}`, `Proposed: ${modelOnly.proposals.map((p) => `${p.name} (${p.phrases.length})`).join('; ') || 'none'}`);
writeFileSync(`${here}out/${process.env.SET2 ? 'ba-mapping-holdout.md' : 'ba-mapping-fresh.md'}`, out.join('\n'));
console.log(out.join('\n'));
console.log(ledger.summary());
