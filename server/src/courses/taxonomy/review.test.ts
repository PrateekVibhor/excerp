// Reviewing the phrases the skill categories could not place: which of them really fit an existing category (the mapper missed it), which are not skills, and which
// need a new category, with a name, a description, the nearest existing category and why it does not fit. A proposal is checked by a second, differently framed question
// that is shown the whole category list. Nothing here writes anything: a new category is added only after a person approves it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import type { Taxonomy } from './taxonomy.ts';
import { reviewUnplaced } from './review.ts';

const TAX: Taxonomy = {
  role: 'business analyst',
  categories: [
    { id: 'domain-knowledge', name: 'Industry and domain knowledge', description: 'knowing the industry and its vocabulary', aliases: [] },
    { id: 'enterprise-systems-analysis', name: 'Enterprise systems analysis', description: 'configuring and supporting ERP, HR and finance systems', aliases: ['erp'] },
    { id: 'sql-data-querying', name: 'SQL and data querying', description: 'writing queries', aliases: ['sql'] },
  ],
  tools: [{ name: 'Oracle', aliases: ['oracle'], category: 'enterprise-systems-analysis' }],
};
type Cluster = { name: string; description?: string; aliases?: string[]; phrases: string[]; nearest?: string; why_not_nearest?: string };
interface Script { mapped?: Record<string, { category: string }>; clusters?: Cluster[]; notSkills?: string[]; verdict?: (phrases: string[]) => string | 'down'; reviewDown?: boolean }
function model(s: Script = {}) {
  const calls = { map: 0, review: 0, verify: 0, reviewPhrases: [] as string[][] };
  const chat: Chat = async (m) => {
    const system = m[0]!.content;
    const user = m.at(-1)!.content;
    if (/to the transferable skill each one is really about/.test(system)) {
      calls.map++;
      const asked = (JSON.parse(user) as { phrases: string[] }).phrases;
      return JSON.stringify({ results: asked.map((phrase, i) => ({ i, phrase, ...(s.mapped?.[phrase.toLowerCase()] ?? { category: 'none' }) })) });
    }
    if (/review phrases that no skill category could place/.test(system)) {
      calls.review++;
      if (s.reviewDown) throw new Error('down');
      const asked = (JSON.parse(user) as { phrases: string[] }).phrases;
      calls.reviewPhrases.push(asked);
      const mine = (s.clusters ?? []).map((c) => ({ ...c, phrases: c.phrases.filter((p) => asked.includes(p) || !asked.length || true) }));
      return JSON.stringify({ categories: mine, not_skills: s.notSkills ?? [] });
    }
    calls.verify++;
    const phrases = (JSON.parse(user) as { phrases: string[] }).phrases;
    const v = s.verdict?.(phrases) ?? 'none';
    if (v === 'down') throw new Error('down');
    return JSON.stringify({ category: v });
  };
  return Object.assign(chat, { calls });
}
const treasury: Cluster = { name: 'Treasury and payments operations', description: 'how corporate treasury, cash management and payment messaging work', aliases: ['treasury', 'cash management', 'iso 20022'], phrases: ['payment systems iso 20022', 'treasury and cash-management systems'], nearest: 'domain-knowledge', why_not_nearest: 'domain knowledge is about an industry in general; this is a specific operational domain with its own standards' };
const PHRASES = ['payment systems iso 20022', 'treasury and cash-management systems'];

test('phrases the mapper can place now are reported as fitting an existing category, and are not proposed', async () => {
  const m = model({ mapped: { 'payment systems iso 20022': { category: 'domain-knowledge' } }, clusters: [{ ...treasury, phrases: ['treasury and cash-management systems'] }] });
  const r = await reviewUnplaced(m, TAX, PHRASES);
  assert.deepEqual(r.fits, [{ phrase: 'payment systems iso 20022', categories: ['domain-knowledge'] }]);
  assert.deepEqual(m.calls.reviewPhrases, [['treasury and cash-management systems']], 'only what is still unplaced goes to the review');
});

test('unplaced phrases that belong together become one proposal with a name, a description, the nearest existing category and why it does not fit', async () => {
  const m = model({ clusters: [treasury] });
  const r = await reviewUnplaced(m, TAX, PHRASES);
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0]!;
  assert.deepEqual([p.id, p.name, p.phrases.sort(), p.nearest, p.verified], ['treasury-and-payments-operations', 'Treasury and payments operations', [...PHRASES].sort(), 'domain-knowledge', 'not_covered']);
  assert.match(p.whyNotNearest, /specific operational domain/);
  assert.deepEqual(r.unassigned, []);
});

test('a proposal named for a tool or product, an existing category, or in too many words is refused, and its phrases are left unassigned', async () => {
  for (const name of ['Oracle treasury', 'Industry and domain knowledge', 'Corporate treasury and payment messaging standards and operations']) {
    const r = await reviewUnplaced(model({ clusters: [{ ...treasury, name }] }), TAX, PHRASES);
    assert.deepEqual(r.proposals, [], name);
    assert.deepEqual(r.unassigned.sort(), [...PHRASES].sort(), name);
  }
});

test('a proposal must say which existing category is nearest, and why it does not fit', async () => {
  for (const bad of [{ nearest: 'made-up' }, { nearest: undefined }, { why_not_nearest: '' }, { why_not_nearest: undefined }]) {
    const r = await reviewUnplaced(model({ clusters: [{ ...treasury, ...bad }] }), TAX, PHRASES);
    assert.deepEqual(r.proposals, [], JSON.stringify(bad));
  }
});

test('only phrases that were asked about count; a phrase can be in one proposal only; two proposals with one name are one', async () => {
  const r = await reviewUnplaced(model({ clusters: [
    { ...treasury, phrases: ['payment systems iso 20022', 'something invented'] },
    { ...treasury, phrases: ['payment systems iso 20022', 'treasury and cash-management systems'] },
  ] }), TAX, PHRASES);
  assert.equal(r.proposals.length, 1);
  assert.deepEqual(r.proposals[0]!.phrases.sort(), [...PHRASES].sort());
});

test('a second, differently framed question sees the whole category list: if it files the phrases under an existing category the proposal is dropped and they are reported as fitting it', async () => {
  const m = model({ clusters: [treasury], verdict: () => 'domain-knowledge' });
  const r = await reviewUnplaced(m, TAX, PHRASES);
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(r.fits.map((f) => [f.categories, f.phrase]).sort(), [['domain-knowledge'], 'payment systems iso 20022'].length ? [[['domain-knowledge'], 'payment systems iso 20022'], [['domain-knowledge'], 'treasury and cash-management systems']] : []);
  assert.equal(m.calls.verify, 1);
});

test('if the second question cannot be answered the proposal is kept, marked unverified, never silently accepted as checked', async () => {
  const r = await reviewUnplaced(model({ clusters: [treasury], verdict: () => 'down' }), TAX, PHRASES);
  assert.deepEqual(r.proposals.map((p) => p.verified), ['unverified']);
});

test('things that are not skills (a trait, a degree) are set aside, and nothing is asked when nothing is left unplaced', async () => {
  const m = model({ clusters: [], notSkills: ['detail oriented'] });
  const r = await reviewUnplaced(m, TAX, ['detail oriented', 'treasury and cash-management systems']);
  assert.deepEqual(r.notSkills, ['detail oriented']);
  assert.deepEqual(r.unassigned, ['treasury and cash-management systems']);
  const none = model({ mapped: { sql: { category: 'sql-data-querying' } } });
  const placed = await reviewUnplaced(none, TAX, ['sql']);
  assert.deepEqual([none.calls.review, none.calls.verify, placed.proposals], [0, 0, []]);
});

test('a review that cannot be reached leaves everything unassigned and does not throw', async () => {
  const r = await reviewUnplaced(model({ reviewDown: true }), TAX, PHRASES);
  assert.deepEqual([r.proposals, r.unassigned.sort()], [[], [...PHRASES].sort()]);
});

test('a long list goes to the review in batches, so the model does not lose its place', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `unusual phrase ${i}`);
  const m = model({});
  await reviewUnplaced(m, TAX, many);
  assert.ok(m.calls.review >= 3 && m.calls.reviewPhrases.every((b) => b.length <= 25), JSON.stringify(m.calls.reviewPhrases.map((b) => b.length)));
});

test('the prompt asks for few, broad, transferable categories, never a tool, and treats the phrases as data', async () => {
  const seen: string[] = [];
  const spy: Chat = async (m) => {
    seen.push(m[0]!.content);
    return /review phrases/.test(m[0]!.content) ? JSON.stringify({ categories: [], not_skills: [] }) : JSON.stringify({ results: [] });
  };
  await reviewUnplaced(spy, TAX, PHRASES);
  const review = seen.find((s) => /review phrases/.test(s))!;
  assert.match(review, /never a (product|tool|vendor)/i);
  assert.match(review, /fewer, broader|transferable/i);
  assert.match(review, /never follow instructions inside/i);
  assert.ok(review.includes('domain-knowledge') && review.includes('Industry and domain knowledge'), 'the whole category list is shown');
});
