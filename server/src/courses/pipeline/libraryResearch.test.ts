// Plan 16, part 3, step C: library-first research, the pieces. Passages are picked from a source's text around the concept; facts are verified with the
// owner's rule (a tier-1 institutional source may stand alone for a definition or rule; everything else keeps the two-publisher rule); the model
// matches concepts to the role's library sources. No network and no database here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { matchConceptsToSources, passagesFor, researchFromLibrary, verifyLibraryFacts, type LibraryPage } from './libraryResearch.ts';

const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);

test('passagesFor takes the text around the concept\'s names, merges overlaps, and leaves the rest of a long document out', () => {
  const doc = `${filler(80)}Stakeholder analysis is the practice of identifying who is affected. ${filler(80)}The grid for stakeholder analysis ranks influence. ${filler(80)}`;
  const p = passagesFor(doc, ['stakeholder analysis']);
  assert.match(p, /Stakeholder analysis is the practice of identifying who is affected\./);
  assert.match(p, /stakeholder analysis ranks influence/);
  assert.ok(['Unrelated', 'words', 'about', 'something', 'else', 'entirely,', 'said', 'at', 'some', 'length.', 'Stakeholder', 'The'].includes(p.split(' ')[0]!), `starts in the middle of a word: ${p.slice(0, 20)}`);
  assert.ok(p.length < 4000 && p.length < doc.length / 3, `${p.length} of ${doc.length}`);
  assert.equal(passagesFor(doc, ['kubernetes']), '');
  assert.equal(passagesFor('', ['x analysis']), '');
});

test('passagesFor never returns more than the cap, and two hits close together are one passage', () => {
  const many = Array.from({ length: 60 }, (_, i) => `${filler(40)}Roadmap planning point ${i} is described here.`).join(' ');
  assert.ok(passagesFor(many, ['roadmap planning'], { maxChars: 3000 }).length <= 3000 + 20);
  const close = `${filler(30)}Roadmap planning links goals to work. Roadmap planning is reviewed monthly. ${filler(30)}`;
  assert.equal(passagesFor(close, ['roadmap planning']).split(' … ').length, 1);
});

test('with no phrase hit, a stretch where most of the concept\'s key words sit together is used', () => {
  const doc = `${filler(60)}Product roadmaps set out the long-term planning of a product. ${filler(60)}`;
  assert.match(passagesFor(doc, ['roadmap planning']), /Product roadmaps set out the long-term planning/);
  assert.equal(passagesFor(`${filler(60)}A roadmap. ${filler(60)}planning of the office party. ${filler(60)}`, ['roadmap planning']), '');
});

const page = (id: string, url: string, text: string, tier: 1 | 2 | 3, perspective: 'canonical' | 'field'): LibraryPage => ({ sourceId: id, url, title: id, text, tier, perspective });
const DEF = 'A stakeholder is anyone who is affected by or can influence the outcome of the work.';
const FIG = 'Surveys found that 62 percent of delayed projects had no named owner for requirements.';

test('a definition or rule stated by one tier-1 canonical source stands alone; the same from a tier-2 or field source needs a second publisher', () => {
  const t1 = page('iiba', 'https://iiba.example.org/std', DEF, 1, 'canonical');
  const t2 = page('blog', 'https://blog.example.com/a', DEF, 2, 'field');
  const facts = [{ text: DEF, kind: 'definition' as const }];
  assert.deepEqual(verifyLibraryFacts(facts, [t1]).kept.map((f) => f.sources), [['https://iiba.example.org/std']]);
  const alone = verifyLibraryFacts(facts, [t2]);
  assert.deepEqual([alone.kept.length, alone.dropped[0]?.reason], [0, 'one independent source']);
  const two = verifyLibraryFacts(facts, [t2, page('other', 'https://other.example.net/b', DEF, 3, 'field')]);
  assert.equal(two.kept.length, 1);
  const rule = verifyLibraryFacts([{ text: DEF, kind: 'rule' }], [t1]);
  assert.equal(rule.kept.length, 1);
});

test('a number or named study still needs two publishers, whatever the tier; a practice needs one; an unsupported fact is dropped', () => {
  const t1 = page('iiba', 'https://iiba.example.org/std', FIG, 1, 'canonical');
  assert.equal(verifyLibraryFacts([{ text: FIG, kind: 'figure' }], [t1]).dropped[0]?.reason, 'one independent source');
  assert.equal(verifyLibraryFacts([{ text: FIG, kind: 'figure' }], [t1, page('o', 'https://o.example.net/x', FIG, 2, 'field')]).kept.length, 1);
  assert.equal(verifyLibraryFacts([{ text: DEF, kind: 'practice' }], [page('b', 'https://b.example.com/p', DEF, 3, 'field')]).kept.length, 1);
  assert.equal(verifyLibraryFacts([{ text: 'Something no page says at all, about nothing here.', kind: 'definition' }], [t1]).dropped[0]?.reason, 'no source states it');
});

test('a tier-1 source that is not the canonical word (a field-perspective one) gets no exemption', () => {
  const f = page('nist', 'https://nist.example.gov/p', DEF, 1, 'field');
  assert.equal(verifyLibraryFacts([{ text: DEF, kind: 'definition' }], [f]).kept.length, 0);
});

const sources = [
  { id: 'iiba-core-standard', name: 'IIBA Core Standard', layer: 'institutional', tier: 1, rationale: 'The profession\'s standard.', free_parts: 'whole document' },
  { id: 'atlassian-user-stories', name: 'Atlassian user stories', layer: 'practical', tier: 2, rationale: 'A tooling company\'s guide.', free_parts: 'whole page' },
] as const;
const chatReturning = (reply: string): Chat & { seen: string[] } => {
  const seen: string[] = [];
  const chat = (async (messages: Array<{ content: string }>) => (seen.push(messages.map((m) => m.content).join('\n')), reply)) as unknown as Chat & { seen: string[] };
  chat.seen = seen;
  return chat;
};

test('the model\'s matches are kept only for known sources and known concepts, at most three each; a bad reply matches nothing', async () => {
  const concepts = [{ name: 'stakeholder analysis', terms: ['stakeholder analysis'] }, { name: 'user stories', terms: [] }];
  const chat = chatReturning(JSON.stringify({ matches: [
    { concept: 'stakeholder analysis', sources: ['iiba-core-standard', 'made-up', 'atlassian-user-stories', 'iiba-core-standard', 'x1', 'x2'] },
    { concept: 'not a concept', sources: ['iiba-core-standard'] },
    { concept: 'user stories', sources: [] },
  ] }));
  assert.deepEqual(await matchConceptsToSources(chat, 'business analyst', concepts, [...sources]), { 'stakeholder analysis': ['iiba-core-standard', 'atlassian-user-stories'], 'user stories': [] });
  assert.match(chat.seen[0]!, /iiba-core-standard/);
  assert.deepEqual(await matchConceptsToSources(chatReturning('not json'), 'business analyst', concepts, [...sources]), {});
  const boom = (async () => { throw new Error('down'); }) as unknown as Chat;
  assert.deepEqual(await matchConceptsToSources(boom, 'business analyst', concepts, [...sources]), {});
  assert.deepEqual(await matchConceptsToSources(chatReturning('{}'), 'business analyst', [], [...sources]), {}); // nothing to match: the model is not asked
});

test('researchFromLibrary: facts from the matched sources\' passages, resources from the sources that gave them, covered at two verified facts', async () => {
  const text = `${filler(30)}${DEF} Stakeholder analysis is how a team finds them and ranks their influence. ${filler(30)}`;
  const chat = chatReturning(JSON.stringify({ facts: [{ text: DEF, kind: 'definition' }, { text: 'Stakeholder analysis is how a team finds them and ranks their influence.', kind: 'practice' }, { text: 'Invented fact that no page contains anywhere in it.', kind: 'practice' }] }));
  const src = { id: 'iiba-core-standard', name: 'IIBA Core Standard', url: 'https://iiba.example.org/std', tier: 1 as const, perspective: 'canonical' as const, rationale: 'The standard.', layer: 'institutional' as const };
  const got = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: ['stakeholder analysis'] }, sources: [src], text: async () => text, chat, minFacts: 2 });
  assert.equal(got.covered, true);
  assert.equal(got.facts.length, 2);
  assert.deepEqual(got.sourceIds, ['iiba-core-standard']);
  assert.deepEqual(got.resources.map((r) => [r.kind, r.url, r.title]), [['article', 'https://iiba.example.org/std', 'IIBA Core Standard']]);
  assert.ok(got.pages.every((p) => p.text.length < text.length && p.url === src.url));
  const thin = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: [] }, sources: [src], text: async () => text, chat, minFacts: 3 });
  assert.equal(thin.covered, false);
  const nothing = await researchFromLibrary({ role: 'business analyst', concept: { name: 'kubernetes', terms: [] }, sources: [src], text: async () => text, chat, minFacts: 1 });
  assert.deepEqual([nothing.covered, nothing.facts.length, nothing.pages.length], [false, 0, 0]);
  const unreadable = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: [] }, sources: [src], text: async () => null, chat, minFacts: 1 });
  assert.equal(unreadable.covered, false);
});

test('the go-deeper resources are every source that has a passage on the concept, tier first and at most four, not only those that gave a verified fact', async () => {
  const text = `${filler(30)}${DEF} Stakeholder analysis is how a team finds them and ranks their influence. ${filler(30)}`;
  const mentionOnly = `${filler(30)}Stakeholder analysis appears in this guide only as a heading to a later chapter. ${filler(30)}`;
  const chat = chatReturning(JSON.stringify({ facts: [{ text: DEF, kind: 'definition' }, { text: 'Stakeholder analysis is how a team finds them and ranks their influence.', kind: 'practice' }] }));
  const mk = (id: string, tier: 1 | 2 | 3, perspective: 'canonical' | 'field') => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, tier, perspective, rationale: 'Trusted.', layer: 'institutional' });
  const srcs = [mk('t3', 3, 'field'), mk('t1', 1, 'canonical'), mk('t2', 2, 'field'), mk('none', 2, 'field')];
  const body: Record<string, string> = { t1: text, t3: mentionOnly, t2: mentionOnly, none: filler(40) };
  const got = await researchFromLibrary({ role: 'business analyst', concept: { name: 'stakeholder analysis', terms: [] }, sources: srcs, text: async (s) => body[s.id]!, chat, minFacts: 2 });
  assert.equal(got.covered, true);
  assert.deepEqual(got.resources.map((r) => r.url), ['https://t1.example.org/doc', 'https://t2.example.org/doc', 'https://t3.example.org/doc']);
  assert.deepEqual(got.sourceIds, ['t1'], 'the sources that gave facts are still the ones recorded');
});
