/** R1 syllabus comparison, step 2: agreement of each approach with the pairs the kept syllabi order consistently. Prints markdown. */
import { readFileSync } from 'node:fs';
import { pairViolations, wilson } from './r1Logic.ts';
import { consistentPairs } from './r1Syllabus.ts';

const here = new URL('.', import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${here}out/r1/${f}`, 'utf8'));
const ROLES = ['product manager', 'business analyst', 'data analyst', 'project manager', 'compliance officer', 'backend software engineer', 'financial advisor', 'finops analyst'];
const MIN_PAIRS = 10;
const APPROACHES = ['baseline', 'A', 'B', 'C'] as const;
const pool: Record<string, { k: number; n: number }> = Object.fromEntries(APPROACHES.map((a) => [a, { k: 0, n: 0 }]));
const lines: string[] = [];
const kept: string[] = [];
const few: string[] = [];

for (const role of ROLES) {
  const slug = role.replace(/[^a-z0-9]+/gi, '-');
  const map = read(`syllabus-map-${slug}.json`) as { pages: Array<{ kind: string; topics: string[]; mapped: Array<{ topic: string; concept: string }> }> };
  const syllabi = map.pages.filter((p) => p.kind === 'syllabus' && p.mapped.length >= 2).map((p) => [...p.mapped].sort((x, y) => p.topics.indexOf(x.topic) - p.topics.indexOf(y.topic)).map((m) => m.concept));
  const pairs = consistentPairs(syllabi);
  kept.push(`| ${role} | ${map.pages.length} | ${map.pages.filter((p) => p.kind === 'syllabus').length} | ${syllabi.length} | ${syllabi.map((s) => s.length).join(', ') || '-'} | ${pairs.length} |`);
  const d = read(`${slug}.json`) as { baseline: string[]; repeats: Array<Record<string, string[]>> };
  const row = [role, String(pairs.length)];
  for (const a of APPROACHES) {
    const orders = a === 'baseline' ? [d.baseline] : d.repeats.map((r) => r[a]!);
    let violations = 0;
    let total = 0;
    for (const o of orders) { const v = pairViolations(o, pairs); violations += v.violations; total += v.decisive; }
    row.push(total ? `${f((1 - violations / total) * 100)}% of ${total}` : '-');
    pool[a]!.k += total - violations;
    pool[a]!.n += total;
  }
  (pairs.length >= MIN_PAIRS ? lines : few).push(`| ${row.join(' | ')} |`);
}
function f(x: number) { return x.toFixed(0); }
const head = '| role | syllabus-consistent pairs | baseline | A | B | C |\n|---|---|---|---|---|---|';
const pooled = APPROACHES.map((a) => { const w = wilson(pool[a]!.k, pool[a]!.n); return `| ${a} | ${pool[a]!.k}/${pool[a]!.n} = ${f(w.rate * 100)}% (${f(w.low * 100)}–${f(w.high * 100)}%) |`; });
console.log(`### Pages kept\n| role | pages | judged syllabus | used (2+ matched concepts) | matched concepts per syllabus | pairs that 2+ syllabi order the same way |\n|---|---|---|---|---|---|\n${kept.join('\n')}\n\n### Agreement with the syllabus order (roles with ${MIN_PAIRS}+ pairs)\n${head}\n${lines.join('\n')}\n\n### Roles with too few pairs (under ${MIN_PAIRS}), not pooled\n${head}\n${few.join('\n')}\n\n### Pooled over all roles (21 distinct pairs, so only an indication)\n| approach | agreeing pairs (Wilson 95%) |\n|---|---|\n${pooled.join('\n')}`);
