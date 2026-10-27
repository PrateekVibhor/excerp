/** Pure helpers for the R1 (concept sequencing) prototypes: orderings, course shape and the measures used to compare them. No network. */

export type Edge = [string, string]; // [a, b]: a is learned before b
export type Priority = (concept: string) => number; // higher is more critical

const byPriority = (priority: Priority) => (x: string, y: string) => priority(y) - priority(x) || x.localeCompare(y);

/**
 * Approach A. Orders concepts so each comes after the ones it depends on; among those ready, the most critical goes first. Edges that
 * name an unknown concept or point at themselves are ignored. A cycle is broken by dropping the incoming edges of one concept, which are returned.
 */
export function topoOrder(concepts: string[], edges: Edge[], priority: Priority): { order: string[]; droppedEdges: Edge[] } {
  const known = new Set(concepts);
  const seen = new Set<string>();
  const live: Edge[] = [];
  for (const [a, b] of edges) {
    const key = `${a}\u0000${b}`;
    if (a === b || !known.has(a) || !known.has(b) || seen.has(key)) continue;
    seen.add(key);
    live.push([a, b]);
  }
  const remaining = new Set(concepts);
  const droppedEdges: Edge[] = [];
  const order: string[] = [];
  const incoming = (c: string) => live.filter(([a, b]) => b === c && remaining.has(a) && !droppedEdges.some(([x, y]) => x === a && y === b));
  const cmp = byPriority(priority);
  while (remaining.size) {
    const ready = [...remaining].filter((c) => incoming(c).length === 0).sort(cmp);
    if (ready.length) {
      order.push(ready[0]!);
      remaining.delete(ready[0]!);
      continue;
    }
    // Stuck on a cycle: free the concept with the fewest unmet prerequisites (the most critical on a tie).
    const stuck = [...remaining].sort((x, y) => incoming(x).length - incoming(y).length || cmp(x, y))[0]!;
    droppedEdges.push(...incoming(stuck));
  }
  return { order, droppedEdges };
}

/** Approach B. Earlier stages first, then the more critical, then by name. */
export function stageOrder(stages: Record<string, number>, priority: Priority): string[] {
  const cmp = byPriority(priority);
  return Object.keys(stages).sort((x, y) => stages[x]! - stages[y]! || cmp(x, y));
}

/** Approach C. The stages of B, with prerequisite edges used only inside a stage. */
export function hybridOrder(stages: Record<string, number>, edges: Edge[], priority: Priority): string[] {
  const levels = [...new Set(Object.values(stages))].sort((a, b) => a - b);
  return levels.flatMap((level) => {
    const inLevel = Object.keys(stages).filter((c) => stages[c] === level);
    return topoOrder(inLevel, edges, priority).order;
  });
}

/** Chapters of two or three concepts, grouped into sections of four to six chapters where that is possible (`ok` says whether it was). */
export function shapeCourse(order: string[]): { sections: string[][][]; ok: boolean } {
  const n = order.length;
  const chapterCount = Math.max(1, Math.ceil(n / 3));
  const base = Math.floor(n / chapterCount);
  const extra = n % chapterCount;
  const chapters: string[][] = [];
  let at = 0;
  for (let i = 0; i < chapterCount; i++) {
    const size = base + (i < extra ? 1 : 0);
    chapters.push(order.slice(at, at + size));
    at += size;
  }
  let sectionCount = 0;
  for (let s = 1; s <= chapterCount; s++) if (Math.floor(chapterCount / s) >= 4 && Math.ceil(chapterCount / s) <= 6) { sectionCount = s; break; }
  const ok = sectionCount > 0;
  if (!ok) sectionCount = Math.max(1, Math.ceil(chapterCount / 6));
  const sections: string[][][] = [];
  const per = Math.floor(chapterCount / sectionCount);
  const more = chapterCount % sectionCount;
  at = 0;
  for (let i = 0; i < sectionCount; i++) {
    const size = per + (i < more ? 1 : 0);
    sections.push(chapters.slice(at, at + size));
    at += size;
  }
  return { sections, ok: ok && chapters.every((c) => c.length >= 2 && c.length <= 3) };
}

/** The share of concept pairs, among those both orders contain, that the two orders put the other way round: 0 is the same order, 1 the reverse. */
export function kendallDistance(a: string[], b: string[]): number {
  const inB = new Map(b.map((c, i) => [c, i]));
  const common = a.filter((c) => inB.has(c));
  const m = common.length;
  if (m < 2) return 0;
  let discordant = 0;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (inB.get(common[i]!)! > inB.get(common[j]!)!) discordant++;
  return discordant / ((m * (m - 1)) / 2);
}

/** The fewest concepts to pick up and put somewhere else to turn `model` into `corrected` (the rest keep their relative order). */
export function movesNeeded(model: string[], corrected: string[]): number {
  const pos = new Map(corrected.map((c, i) => [c, i]));
  const seq = model.filter((c) => pos.has(c)).map((c) => pos.get(c)!);
  const tails: number[] = []; // longest increasing subsequence, patience style
  for (const x of seq) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return seq.length - tails.length;
}

export interface LabelledPair {
  a: string;
  b: string;
  /** Which comes first: a, b, or either order is fine. */
  first: 'a' | 'b' | 'either';
}

/** How many of the owner's decisive labels an order breaks. A pair with a concept missing from the order is not counted. */
export function pairViolations(order: string[], pairs: LabelledPair[]): { violations: number; decisive: number; total: number } {
  const pos = new Map(order.map((c, i) => [c, i]));
  let violations = 0;
  let decisive = 0;
  for (const p of pairs) {
    if (p.first === 'either' || !pos.has(p.a) || !pos.has(p.b)) continue;
    decisive++;
    const aFirst = pos.get(p.a)! < pos.get(p.b)!;
    if (aFirst !== (p.first === 'a')) violations++;
  }
  return { violations, decisive, total: pairs.length };
}

/** A 95% Wilson interval for k out of n. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number; rate: number } {
  if (n === 0) return { low: 0, high: 1, rate: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: k === 0 ? 0 : Math.max(0, center - half), high: k === n ? 1 : Math.min(1, center + half), rate: p };
}

/** The share of the most critical concepts that land in the first third of the order. */
export function highEarly(order: string[], high: Set<string>): number {
  const inOrder = order.filter((c) => high.has(c));
  if (inOrder.length === 0) return 0;
  const third = Math.max(1, Math.ceil(order.length / 3));
  const early = new Set(order.slice(0, third));
  return inOrder.filter((c) => early.has(c)).length / inOrder.length;
}

/** How much repeated runs agree: 1 if they give the same order, lower as they differ (the mean of 1 minus the distance over every pair of runs). */
export function stabilityOf(orders: string[][]): number {
  if (orders.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < orders.length; i++) for (let j = i + 1; j < orders.length; j++) (total += 1 - kendallDistance(orders[i]!, orders[j]!)), pairs++;
  return total / pairs;
}

/** The automatic order check: an order that breaks more than `maxRate` of the known prerequisite pairs is clearly wrong. */
export function checkOrder(order: string[], pairs: LabelledPair[], maxRate = 0.2): { ok: boolean; rate: number; violations: number; decisive: number } {
  const { violations, decisive } = pairViolations(order, pairs);
  const rate = decisive === 0 ? 0 : violations / decisive;
  return { ok: rate <= maxRate, rate, violations, decisive };
}
