/** R2 helpers (plan 16, phase 3): matching a claim to a span of source text, and scoring the QA agent against planted errors. */

const STOP = new Set('a an the of to in on for and or but is are was were be been it its this that these those with as by at from than then so such can may will would should must not no more most any each every over under into about also their there which who whom when while if'.split(' '));

const tokens = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+(?:[.,][0-9]+)*/g) ?? []).map((t) => (t.length > 3 && /^[a-z]+$/.test(t) ? t.replace(/(ing|ed|es|s)$/, '') : t)).filter((t) => !STOP.has(t) && t.length > 0);
const NUMBER_WORDS = 'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|ninety|hundred|thousand|million|billion|half|double|triple';
const numbers = (text: string): string[] => (text.toLowerCase().match(new RegExp(`\\d+(?:[.,]\\d+)*|\\b(?:${NUMBER_WORDS})\\b`, 'g')) ?? []);
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** The best-matching span (one sentence or two neighbours) for a claim; supported when most of its content words and all its numbers are in the span. */
export function bestSpan(claim: string, source: string, minCoverage = 0.6): { supported: boolean; span: string; coverage: number } {
  const want = [...new Set(tokens(claim))];
  const nums = numbers(claim);
  const sents = sentences(source);
  let best = { supported: false, span: '', coverage: 0 };
  if (want.length === 0) return best;
  for (let i = 0; i < sents.length; i++)
    for (const width of [1, 2]) {
      const span = sents.slice(i, i + width).join(' ');
      if (width === 2 && i + 1 >= sents.length) continue;
      const have = new Set(tokens(span));
      const coverage = want.filter((t) => have.has(t)).length / want.length;
      if (coverage > best.coverage) best = { supported: false, span, coverage };
    }
  const spanNumbers = new Set(numbers(best.span));
  best.supported = best.coverage >= minCoverage && nums.every((n) => spanNumbers.has(n));
  return best;
}

/** True when most of the planted sentence's content words appear in the flagged text. */
export function overlaps(flagged: string, planted: string, min = 0.6): boolean {
  const want = [...new Set(tokens(planted))];
  const have = new Set(tokens(flagged));
  return want.length > 0 && want.filter((t) => have.has(t)).length / want.length >= min;
}

export interface Planted { id: string; category: string; sentence: string; chapter: string }
export interface Flag { chapter: string; text: string }

/** The share of planted claims that at least one flag in the same chapter overlaps, overall and per category. */
export function catchRate(planted: Planted[], flags: Flag[]) {
  const overall = { caught: 0, total: 0 };
  const byCategory: Record<string, { caught: number; total: number }> = {};
  const missed: string[] = [];
  for (const p of planted) {
    const hit = flags.some((f) => f.chapter === p.chapter && overlaps(f.text, p.sentence));
    const c = (byCategory[p.category] ??= { caught: 0, total: 0 });
    c.total++;
    overall.total++;
    if (hit) { c.caught++; overall.caught++; } else missed.push(p.id);
  }
  return { overall, byCategory, missed };
}
