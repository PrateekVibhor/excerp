// Plan 16, phase 4, stage 8 (first half): the coverage plan (spec decision 33). Skills and scenarios, in the order stage 7 gave, are grouped
// into cards of two or three concepts and cards into sections of four to six where possible. The number of cards is whatever the concepts need:
// there is no cap, and every concept is placed exactly once.
import { shapeCourse } from './order.ts';

export interface PlanConcept {
  name: string;
  kind: 'skill' | 'scenario';
  criticality: 'high' | 'medium' | 'low' | null;
  mentions: number;
  fromReaderSource: boolean;
}
export interface Card {
  concepts: string[];
}

export function planCards(concepts: PlanConcept[], order: string[]) {
  const known = new Set(concepts.map((c) => c.name));
  const placed: string[] = [];
  for (const name of order) if (known.has(name) && !placed.includes(name)) placed.push(name);
  const added = concepts.map((c) => c.name).filter((n) => !placed.includes(n));
  const sequence = [...placed, ...added];
  const shaped = shapeCourse(sequence);
  const sections: Card[][] = shaped.sections.map((s) => s.map((concepts) => ({ concepts })));
  const inCards = new Set(sections.flat().flatMap((c) => c.concepts));
  // What the plan promises to cover: high and medium skills, every scenario kept (two mentions), and what the reader's own posting asked for.
  const required = concepts.filter((c) => c.criticality === 'high' || c.criticality === 'medium' || c.kind === 'scenario' || c.fromReaderSource).map((c) => c.name);
  return { sections, added, required, uncovered: required.filter((n) => !inCards.has(n)), ok: shaped.ok };
}
