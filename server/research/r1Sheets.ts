/**
 * R1 sheets (plan 16, phase 3): the owner's blind pair-labelling sheet and the shuffled order-rating sheet with a hidden key.
 *   node research/r1Sheets.ts "product manager" "business analyst" "data analyst"
 * Writes out/r1/labels-<role>.md (fill in "answer:"), out/r1/rating.md (fill in "score:"), out/r1/rating-key.json (do not open until rated).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const slug = (role: string) => role.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const PAIRS = 30;
const LABELLED = new Set(['product manager', 'business analyst', 'data analyst']); // roles the owner knows well enough to label pairs

// small seeded generator so the sheets can be rebuilt identically
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const rating: string[] = ['# Rate each order of concepts for how well it reads as a course (1 = confusing, 5 = a sensible path to learn in).', '', 'Fill in "score:" for each order. Do not open rating-key.json until you are done.', ''];
const key: Record<string, string> = {};
const rand = rng(16);

for (const role of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(`${here}out/r1/${slug(role)}.json`, 'utf8')) as { concepts: string[]; baseline: string[]; repeats: Array<{ A: string[]; B: string[]; C: string[] }> };
  const pairs: Array<[string, string]> = [];
  const all = data.concepts.flatMap((a, i) => data.concepts.slice(i + 1).map((b): [string, string] => [a, b]));
  for (const [a, b] of shuffle(all, rand).slice(0, PAIRS)) pairs.push(rand() < 0.5 ? [a, b] : [b, a]);
  if (LABELLED.has(role)) writeFileSync(
    `${here}out/r1/labels-${slug(role)}.md`,
    [`# ${role}: which should a learner meet first?`, '', 'For each pair write "answer:" a, b or either. Your first sitting is the one that counts.', '', ...pairs.map(([a, b], i) => `${i + 1}. a: ${a} | b: ${b} | answer:`), ''].join('\n'),
  );
  const orders = shuffle([['baseline', data.baseline], ['A', data.repeats[0]!.A], ['B', data.repeats[0]!.B], ['C', data.repeats[0]!.C]] as Array<[string, string[]]>, rand);
  rating.push(`## ${role}`, '');
  orders.forEach(([name, order], i) => {
    const id = `${slug(role)}-${'WXYZ'[i]}`;
    key[id] = name;
    rating.push(`### Order ${id}`, ...order.map((c, n) => `${n + 1}. ${c}`), '', 'score:', '');
  });
}
writeFileSync(`${here}out/r1/rating.md`, rating.join('\n'));
writeFileSync(`${here}out/r1/rating-key.json`, `${JSON.stringify(key, null, 1)}\n`);
console.log('sheets written');
