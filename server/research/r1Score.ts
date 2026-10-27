/** R1 scoring (plan 16, phase 3): reads out/r1/*.json, ratings.json, rating-key.json and the owner's label files; writes r1-result.md. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { highEarly, pairViolations, shapeCourse, stabilityOf, wilson, type LabelledPair } from './r1Logic.ts';

const here = new URL('.', import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${here}out/r1/${f}`, 'utf8'));
const ratings = read('ratings.json') as Record<string, Record<string, number>>;
const key = read('rating-key.json') as Record<string, string>;
const APPROACHES = ['baseline', 'A', 'B', 'C'] as const;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number, d = 2) => (Number.isNaN(x) ? 'n/a' : x.toFixed(d));

const score: Record<string, number[]> = Object.fromEntries(APPROACHES.map((a) => [a, []]));
const stab: Record<string, number[]> = { A: [], B: [], C: [] };
const early: Record<string, number[]> = Object.fromEntries(APPROACHES.map((a) => [a, []]));
const shapeOk: Record<string, number> = { baseline: 0, A: 0, B: 0, C: 0 };
const pairs: Record<string, { k: number; n: number }> = Object.fromEntries(APPROACHES.map((a) => [a, { k: 0, n: 0 }]));
const perRole: string[] = [];
let labelled = 0;

for (const [role, letters] of Object.entries(ratings)) {
  const d = read(`${role}.json`);
  const high = new Set<string>(read(`../r0-${role}.json`).ranked.filter((r: { band: string }) => r.band === 'high').map((r: { skill: string }) => r.skill));
  const labelFile = `${here}out/r1/labels-${role}.md`;
  const labels: LabelledPair[] = existsSync(labelFile)
    ? [...readFileSync(labelFile, 'utf8').matchAll(/^\d+\. a: (.+?) \| b: (.+?) \| answer:\s*(a|b|either)\s*$/gim)].map((m) => ({ a: m[1]!, b: m[2]!, first: m[3]!.toLowerCase() as 'a' | 'b' | 'either' }))
    : [];
  if (labels.length) labelled++;
  const row = [role];
  for (const [letter, value] of Object.entries(letters)) {
    const a = key[`${role}-${letter}`]!;
    score[a]!.push(value);
    row.push(`${a} ${value}`);
  }
  perRole.push(`| ${row.join(' | ')} |`);
  for (const a of APPROACHES) {
    const orders: string[][] = a === 'baseline' ? [d.baseline] : d.repeats.map((r: Record<string, string[]>) => r[a]);
    if (a !== 'baseline') stab[a]!.push(stabilityOf(orders));
    early[a]!.push(mean(orders.map((o) => highEarly(o, high))));
    if (shapeCourse(orders[0]!).ok) shapeOk[a]!++;
    if (labels.length) for (const o of orders) { const v = pairViolations(o, labels); pairs[a]!.k += v.violations; pairs[a]!.n += v.decisive; }
  }
}

const rows = APPROACHES.map((a) => {
  const w = wilson(pairs[a]!.k, pairs[a]!.n);
  const viol = pairs[a]!.n ? `${pairs[a]!.k}/${pairs[a]!.n} = ${f(w.rate * 100, 0)}% (${f(w.low * 100, 0)}–${f(w.high * 100, 0)}%)` : 'pending labels';
  return `| ${a} | ${f(mean(score[a]!))} (n=${score[a]!.length}) | ${a === 'baseline' ? 'n/a' : f(mean(stab[a]!))} | ${f(mean(early[a]!))} | ${shapeOk[a]}/${Object.keys(ratings).length} | ${viol} |`;
});
const md = `# R1 result: sequencing (plan 16, phase 3)

Eight roles, three runs each of approaches A (model prerequisite graph), B (four stages, criticality inside a stage) and C (stages plus graph inside a stage), against a baseline of most-critical-first. Ratings are the owner's blind 1–5 scores of one run per approach per role.

## Summary
| approach | mean rating | stability | high-criticality share in first third | course shape ok | pair violations (decisive pairs, Wilson 95%) |
|---|---|---|---|---|---|
${rows.join('\n')}

Label files with filled answers found: ${labelled} of 3. ${labelled === 0 ? '**The pair-label files on disk are still blank, so the violation column is not scored.**' : ''}

## Ratings by role (blind letter resolved)
| role | | | | |
|---|---|---|---|---|
${perRole.join('\n')}
`;
writeFileSync(`${here}r1-result.md`, md);
console.log(md);
