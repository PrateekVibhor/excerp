import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCards, type PlanConcept } from './coverage.ts';

const concept = (i: number, over: Partial<PlanConcept> = {}): PlanConcept => ({ name: `concept ${i}`, kind: i % 3 === 0 ? 'scenario' : 'skill', criticality: (['high', 'medium', 'low'] as const)[i % 3]!, mentions: 3, fromReaderSource: false, ...over });
const many = (n: number) => Array.from({ length: n }, (_, i) => concept(i));

test('cards hold two or three concepts and sections four to six cards where that can be done', () => {
  for (const n of [14, 21, 26, 32, 37, 40]) {
    const cs = many(n);
    const plan = planCards(cs, cs.map((c) => c.name));
    const cards = plan.sections.flat();
    assert.ok(cards.every((c) => c.concepts.length >= 2 && c.concepts.length <= 3), `n=${n}`);
    assert.equal(cards.flatMap((c) => c.concepts).length, n);
  }
  const plan = planCards(many(36), many(36).map((c) => c.name)); // 12 cards -> sections of 4 to 6
  assert.ok(plan.sections.every((s) => s.length >= 4 && s.length <= 6));
});

test('there is no cap on the number of cards: the count follows the concepts', () => {
  const small = planCards(many(14), many(14).map((c) => c.name)).sections.flat().length;
  const large = planCards(many(150), many(150).map((c) => c.name)).sections.flat().length;
  assert.equal(large, 50);
  assert.ok(large > small * 5);
});

test('every concept appears in exactly one card, skills and scenarios alike, in the order given', () => {
  const cs = many(20);
  const order = [...cs.map((c) => c.name)].reverse();
  const flat = planCards(cs, order).sections.flat().flatMap((c) => c.concepts);
  assert.deepEqual(flat, order);
  assert.ok(flat.some((n) => cs.find((c) => c.name === n)!.kind === 'scenario'));
});

test('a concept the order left out is added at the end and reported, never lost; a name that is not a concept is ignored', () => {
  const cs = many(12);
  const order = [...cs.slice(0, 11).map((c) => c.name), 'not a concept'];
  const plan = planCards(cs, order);
  assert.deepEqual(plan.added, ['concept 11']);
  assert.equal(plan.sections.flat().flatMap((c) => c.concepts).length, 12);
  assert.ok(!plan.sections.flat().flatMap((c) => c.concepts).includes('not a concept'));
});

test('the coverage report names the high and medium concepts and scenarios and confirms they are all placed', () => {
  const cs = many(15);
  const plan = planCards(cs, cs.map((c) => c.name));
  assert.equal(plan.uncovered.length, 0);
  assert.ok(plan.required.length > 0 && plan.required.every((n) => cs.find((c) => c.name === n)!.criticality !== 'low' || cs.find((c) => c.name === n)!.kind === 'scenario' || cs.find((c) => c.name === n)!.fromReaderSource));
});
