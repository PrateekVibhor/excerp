// Plan 16, part 3, step B: does the library mention a concept at all? Deterministic and model-free, so the dry run costs nothing. It is a floor on
// what a model-based match would find (it knows only the concept's own words), and "mentioned" is not "usable": a mention may be in the wrong
// context, say nothing a fact could be drawn from, or fail the fact-verification rules. The report says so.
export interface ConceptIn { name: string; kind: 'skill' | 'scenario'; terms: string[]; mentions: number }
export type Band = 'strong' | 'single' | 'none';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (term: string) => term.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The pattern for a term: whole words, case-insensitive, with a plural on the last word and any hyphen, slash or space between words. Null for a term under three letters (r, go): they match too much. */
export function termPattern(term: string): RegExp | null {
  const w = words(term);
  if (w.join('').length < 3) return null;
  const last = w.at(-1)!;
  const tail = last.endsWith('y') && last.length > 2 ? `(?:${esc(last.slice(0, -1))}y|${esc(last.slice(0, -1))}ies)` : `${esc(last)}(?:s|es)?`;
  return new RegExp(`(?<![a-z0-9])${[...w.slice(0, -1).map(esc), tail].join('[\\s\\-/]+')}(?![a-z0-9])`, 'gi');
}

export function termHits(text: string, term: string): number {
  const re = termPattern(term);
  return re ? [...text.matchAll(re)].length : 0;
}

const STOP = new Set('and the for with from that this into over under about their there when what which your use using how are was were has have had can will after before while than then them they who whom'.split(' '));
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
const WINDOW = 40;

/** The stems of a concept name's key words (four letters or more, no stop words). */
export const keyStems = (name: string): string[] => [...new Set(words(name).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];
export const stemOf = stem;
export const KEY_WINDOW = WINDOW;

/** A scenario is found when at least three quarters of its key words fall inside one stretch of forty words. */
function scenarioIn(stems: string[], name: string): boolean {
  const keys = keyStems(name);
  if (keys.length === 0) return false;
  if (keys.length === 1) return stems.includes(keys[0]!);
  const need = Math.ceil(keys.length * 0.75);
  const index = new Map(keys.map((k, i) => [k, i]));
  const counts = new Array<number>(keys.length).fill(0);
  let distinct = 0;
  for (let i = 0; i < stems.length; i++) {
    const add = index.get(stems[i]!);
    if (add !== undefined && counts[add]++ === 0) distinct++;
    if (i >= WINDOW) {
      const drop = index.get(stems[i - WINDOW]!);
      if (drop !== undefined && --counts[drop] === 0) distinct--;
    }
    if (distinct >= need) return true;
  }
  return false;
}
export const scenarioHit = (text: string, name: string): boolean => scenarioIn((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem), name);

export interface CoverageRow { concept: ConceptIn; band: Band; sources: Array<{ id: string; hits: number }> }
export interface Coverage {
  rows: CoverageRow[];
  perSource: Array<{ id: string; concepts: number }>;
  summary: { total: number; strong: number; single: number; none: number; mentioned: number; weightedMentioned: number; sourcesWithNone: string[] };
}

export function coverageFor(concepts: ConceptIn[], texts: Array<{ id: string; text: string }>): Coverage {
  const prepared = texts.map((t) => ({ id: t.id, text: t.text, stems: (t.text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem) }));
  const perSource = new Map(texts.map((t) => [t.id, 0]));
  const rows: CoverageRow[] = concepts.map((concept) => {
    const names = [...new Set([concept.name, ...concept.terms].map((t) => t.toLowerCase()))];
    const sources: Array<{ id: string; hits: number }> = [];
    for (const p of prepared) {
      const hits = concept.kind === 'scenario' ? (names.some((n) => scenarioIn(p.stems, n)) ? 1 : 0) : names.reduce((sum, n) => sum + termHits(p.text, n), 0);
      if (hits > 0) {
        sources.push({ id: p.id, hits });
        perSource.set(p.id, perSource.get(p.id)! + 1);
      }
    }
    return { concept, band: sources.length >= 2 ? 'strong' : sources.length === 1 ? 'single' : 'none', sources };
  });
  const count = (b: Band) => rows.filter((r) => r.band === b).length;
  const weight = (r: CoverageRow) => r.concept.mentions;
  const totalWeight = rows.reduce((s, r) => s + weight(r), 0);
  const mentionedWeight = rows.filter((r) => r.band !== 'none').reduce((s, r) => s + weight(r), 0);
  return {
    rows,
    perSource: [...perSource].map(([id, n]) => ({ id, concepts: n })).sort((a, b) => b.concepts - a.concepts),
    summary: {
      total: rows.length, strong: count('strong'), single: count('single'), none: count('none'),
      mentioned: rows.length ? (count('strong') + count('single')) / rows.length : 0,
      weightedMentioned: totalWeight ? mentionedWeight / totalWeight : 0,
      sourcesWithNone: [...perSource].filter(([, n]) => n === 0).map(([id]) => id),
    },
  };
}
