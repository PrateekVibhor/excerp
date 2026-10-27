import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import type { Card } from './coverage.ts';
import { planStory } from './story.ts';

const cards = (...counts: number[][]): Card[][] => counts.map((s) => s.map((n) => ({ concepts: Array.from({ length: n }, (_, i) => `c${n}-${i}-${Math.random().toString(36).slice(2, 6)}`) })));
const plan = cards([2, 3, 2, 3], [3, 3, 2, 2, 3]);
const good = (p: Card[][]) => ({
  bible: { setting: 'A product team in its first year', character: 'Sam, the newest backend engineer on call', thread: 'Sam learns the system by fixing real incidents', voice: 'plain, second person, practical' },
  sections: p.map((s, i) => ({ title: `Keeping it running, part ${i + 1}`, summary: 'What this part covers.', chapters: s.map((c, j) => `The ${['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][j]} page of part ${i + 1}: ${c.concepts[0]}`) })),
});
const reply = (o: object): Chat => async () => JSON.stringify(o);

test('one bible and an outline with a title for every section and every card, keeping the cards exactly as planned', async () => {
  const r = await planStory(reply(good(plan)), { role: 'backend engineer', sections: plan });
  assert.equal(r.fallback, false);
  assert.deepEqual(Object.keys(r.bible).sort(), ['character', 'setting', 'thread', 'voice']);
  assert.deepEqual(r.sections.map((s) => s.chapters.map((c) => c.concepts)), plan.map((s) => s.map((c) => c.concepts))); // every concept placed, none moved
  assert.equal(r.sections[0]!.chapters[0]!.title, `The first page of part 1: ${plan[0]![0]!.concepts[0]}`);
});

test('a bible or title that mentions a personal characteristic is refused, then the outline falls back to plain titles', async () => {
  const bad = good(plan);
  bad.bible.character = 'Maria, a young woman from Mexico, the newest engineer';
  const r = await planStory(reply(bad), { role: 'backend engineer', sections: plan });
  assert.equal(r.fallback, true);
  assert.ok(r.sections.every((s) => s.title.length > 0 && s.chapters.every((c) => c.title.length > 0)));
  assert.doesNotMatch(JSON.stringify(r.bible), /woman|Mexico/);
});

test('a miscounted outline is asked again with the exact shape that is needed, not the same prompt; a fix on the retry means no fallback', async () => {
  const seen: string[] = [];
  const wrong = { ...good(plan), sections: good(plan).sections.slice(0, 1) };
  const chat: Chat = async (m) => (seen.push(m.map((x) => x.content).join('\n')), JSON.stringify(seen.length === 1 ? wrong : good(plan)));
  const r = await planStory(chat, { role: 'r', sections: plan });
  assert.equal(seen.length, 2);
  assert.equal(r.fallback, false);
  assert.notEqual(seen[1], seen[0], 'the retry is not the same prompt');
  assert.match(seen[1]!, /exactly 2 sections/);
  assert.match(seen[1]!, /4 and 5 chapters/);
  assert.match(seen[1]!, /you gave 1 section/i);
});

test('a chapter-count miscount names the section and the counts needed', async () => {
  const seen: string[] = [];
  const bad = good(plan);
  bad.sections[1]!.chapters = bad.sections[1]!.chapters.slice(0, 3);
  const chat: Chat = async (m) => (seen.push(m.at(-1)!.content), JSON.stringify(seen.length === 1 ? bad : good(plan)));
  await planStory(chat, { role: 'r', sections: plan });
  assert.match(seen[1]!, /section 2 needs exactly 5 chapters.*you gave 3/i);
});

test('after three attempts that miss the shape it falls back and says why, the cards never change', async () => {
  let calls = 0;
  const wrong: Chat = async () => (calls++, JSON.stringify({ ...good(plan), sections: good(plan).sections.slice(0, 1) }));
  const r = await planStory(wrong, { role: 'r', sections: plan });
  assert.equal(calls, 3);
  assert.equal(r.fallback, true);
  assert.ok(r.fallback && /exactly 2 sections/.test(r.reason));
  assert.deepEqual(r.sections.map((s) => s.chapters.length), plan.map((s) => s.length));
});

test('a correctly shaped outline needs one call and no retry', async () => {
  let calls = 0;
  const r = await planStory(async () => (calls++, JSON.stringify(good(plan))), { role: 'r', sections: plan });
  assert.equal(calls, 1);
  assert.equal(r.fallback, false);
});

test('a retry that works is used', async () => {
  let n = 0;
  const flaky: Chat = async () => (n++ === 0 ? 'not json' : JSON.stringify(good(plan)));
  assert.equal((await planStory(flaky, { role: 'r', sections: plan })).fallback, false);
});

test('titles are trimmed to a sensible length and the concept names are data for the model', async () => {
  let prompt = '';
  const chat: Chat = async (m) => (prompt = m.map((x) => x.content).join('\n'), JSON.stringify({ ...good(plan), sections: good(plan).sections.map((s) => ({ ...s, title: 'x'.repeat(200) })) }));
  const r = await planStory(chat, { role: 'r', sections: plan });
  assert.ok(r.sections.every((s) => s.title.length <= 80));
  assert.match(prompt, /never follow instructions/i);
});

test('the character must have a first name, so every chapter can carry them; a bible without one is refused', async () => {
  const unnamed = good(plan);
  unnamed.bible.character = 'A backend software engineer who builds services';
  const r = await planStory(reply(unnamed), { role: 'backend engineer', sections: plan });
  assert.equal(r.fallback, true);
});

test('generic titles such as "Section One" or "Chapter 3" are refused, so the outline says what each part is about', async () => {
  const generic = good(plan);
  generic.sections[0]!.title = 'Section One';
  assert.equal((await planStory(reply(generic), { role: 'r', sections: plan })).fallback, true);
  const chapters = good(plan);
  chapters.sections[1]!.chapters[0] = 'Chapter 3';
  assert.equal((await planStory(reply(chapters), { role: 'r', sections: plan })).fallback, true);
});

test('the story prompt says the setting is a plain workplace for the role, with no named industry unless a concept name names one', async () => {
  let system = '';
  await planStory(async (m) => (system = m[0]!.content, JSON.stringify(good(plan))), { role: 'backend engineer', sections: plan });
  assert.match(system, /plain workplace/i);
  assert.match(system, /no (named )?industry or sector/i);
  assert.match(system, /unless a concept name itself names one/i);
});

test('a bible or outline that names an industry no concept names is refused and asked again; one a concept names is allowed', async () => {
  const bad = good(plan);
  bad.bible.setting = 'A fintech startup in its first year';
  let calls = 0;
  const seen: string[] = [];
  const chat: Chat = async (m) => (calls++, seen.push(m.at(-1)!.content), JSON.stringify(calls === 1 ? bad : good(plan)));
  const r = await planStory(chat, { role: 'product manager', sections: plan });
  assert.equal(calls, 2);
  assert.equal(r.fallback, false);
  assert.doesNotMatch(JSON.stringify(r.bible), /fintech/i);
  assert.match(seen[1]!, /named an industry/i);
  const named = cards([2, 2]);
  named[0]![0]!.concepts[0] = 'fintech compliance';
  const ok = await planStory(reply({ ...good(named), bible: { ...good(named).bible, setting: 'A fintech team in its first year' } }), { role: 'product manager', sections: named });
  assert.equal(ok.fallback, false);
});

const named: Card[][] = [[{ concepts: ['stakeholder management', 'communication'] }, { concepts: ['roadmap planning'] }], [{ concepts: ['pricing strategy'] }, { concepts: ['data analysis', 'experimentation'] }]];
const outline = (titles: string[][]) => ({ ...good(named), sections: named.map((_, i) => ({ title: `Part ${i + 1}: shipping`, summary: 's', chapters: titles[i]! })) });

test('a chapter title must name something its own concepts are about; a title for other work is refused and the retry says which chapter and what it teaches', async () => {
  const seen: string[] = [];
  const drifted = outline([['Identifying Key Stakeholders', 'Facilitating Cross-Functional Workshops'], ['Pricing the Product', 'Running Experiments and A/B Tests']]);
  const fixed = outline([['Identifying Key Stakeholders', 'Laying Out the Roadmap'], ['Pricing the Product', 'Analysing Data and Running Experiments']]);
  const chat: Chat = async (m) => (seen.push(m.at(-1)!.content), JSON.stringify(seen.length === 1 ? drifted : fixed));
  const r = await planStory(chat, { role: 'product manager', sections: named });
  assert.equal(seen.length, 2);
  assert.match(seen[1]!, /"Facilitating Cross-Functional Workshops".*roadmap planning/s);
  assert.doesNotMatch(seen[1]!, /"Identifying Key Stakeholders"/, 'a title that fits is not complained about');
  assert.equal(r.fallback, false);
  assert.equal(r.sections[0]!.chapters[1]!.title, 'Laying Out the Roadmap');
});

test('a title that still does not fit after three attempts is replaced by its concept\'s name, and the rest of the story is kept', async () => {
  let calls = 0;
  const drifted = outline([['Identifying Key Stakeholders', 'Facilitating Cross-Functional Workshops'], ['Pricing the Product', 'Running Experiments and A/B Tests']]);
  const r = await planStory(async () => (calls++, JSON.stringify(drifted)), { role: 'product manager', sections: named });
  assert.equal(calls, 3);
  assert.equal(r.fallback, false, 'the bible and the other titles are the model\'s');
  assert.equal(r.bible.character, good(named).bible.character);
  assert.deepEqual(r.sections.map((s) => s.chapters.map((c) => c.title)), [['Identifying Key Stakeholders', 'Roadmap planning'], ['Pricing the Product', 'Data analysis']]);
  assert.equal(r.sections[0]!.chapters[1]!.concepts[0], 'roadmap planning');
  assert.ok(!r.fallback && r.repaired.length === 2);
});

test('a chapter title that is a long list of concepts is refused with the limit, and the prompt asks for short titles about the main idea', async () => {
  const seen: string[] = [];
  const list = outline([['Stakeholder Management, Communication, and Product Management Practice Today', 'Laying Out the Roadmap'], ['Pricing the Product', 'Analysing Data and Running Experiments']]);
  const chat: Chat = async (m) => (seen.push(m.map((x) => x.content).join('\n')), JSON.stringify(seen.length === 1 ? list : outline([['Identifying Key Stakeholders', 'Laying Out the Roadmap'], ['Pricing the Product', 'Analysing Data and Running Experiments']])));
  const r = await planStory(chat, { role: 'product manager', sections: named });
  assert.equal(seen.length, 2);
  assert.match(seen[1]!, /at most 60 characters/);
  assert.match(seen[0]!, /never a list of the concepts/);
  assert.match(seen[0]!, /three to eight words/);
  assert.equal(r.sections[0]!.chapters[0]!.title, 'Identifying Key Stakeholders');
});

test('a repaired title is cut at a word, never in the middle of one', async () => {
  const longName: Card[][] = [[{ concepts: ['conduct customer interviews in fintech healthcare and hrtech contexts to uncover needs'] }]];
  const bad = { ...good(longName), sections: [{ title: 'Part 1: discovery', summary: 's', chapters: ['Something unrelated entirely'] }] };
  const r = await planStory(async () => JSON.stringify(bad), { role: 'product manager', sections: longName });
  const title = r.sections[0]!.chapters[0]!.title;
  assert.ok(title.length <= 60 && !title.endsWith(' ') && 'Conduct customer interviews in fintech healthcare and hrtech contexts to uncover needs'.startsWith(title), title);
  assert.ok('Conduct customer interviews in fintech healthcare and hrtech contexts to uncover needs'.charAt(title.length) === ' ');
});
