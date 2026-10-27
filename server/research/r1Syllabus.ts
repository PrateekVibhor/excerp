import type { LabelledPair } from './r1Logic.ts';

/** Concept pairs that at least `minSyllabi` syllabi order, all the same way. Each syllabus is its concepts in order of first appearance. */
export function consistentPairs(syllabi: string[][], minSyllabi = 2): LabelledPair[] {
  const seen = new Map<string, { a: string; b: string; forward: number; backward: number }>();
  for (const raw of syllabi) {
    const s = [...new Set(raw)];
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) {
        const [a, b] = s[i]! < s[j]! ? [s[i]!, s[j]!] : [s[j]!, s[i]!];
        const e = seen.get(`${a}\u0000${b}`) ?? { a, b, forward: 0, backward: 0 };
        if (s[i] === a) e.forward++;
        else e.backward++;
        seen.set(`${a}\u0000${b}`, e);
      }
  }
  return [...seen.values()]
    .filter((e) => e.forward + e.backward >= minSyllabi && (e.forward === 0 || e.backward === 0))
    .map((e) => ({ a: e.forward ? e.a : e.b, b: e.forward ? e.b : e.a, first: 'a' as const }));
}
