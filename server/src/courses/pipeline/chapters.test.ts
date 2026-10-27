import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { wordCount, writeChapter, type ChapterInput } from './chapters.ts';

const words = (n: number, seed = 'word') => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(' ');
const input = (over: Partial<ChapterInput> = {}): ChapterInput => ({
  role: 'backend engineer',
  bible: { setting: 'A payments team', character: 'Sam, the newest engineer on call', thread: 'learning through incidents', voice: 'plain and practical' },
  section: 'Part 1: keeping it running',
  title: 'The first page at 3am',
  concepts: [{ name: 'debugging', terms: ['debugging', 'debug'], facts: ['Reproduce the failure before changing anything.'], reused: false }, { name: 'observability', terms: ['observability', 'monitoring'], facts: [], reused: false }],
  previous: [{ title: 'Before the pager', gist: 'Sam read the runbook.' }],
  ...over,
});
const chapter = (n: number) => `Sam opened the debugging notes and began to debug the failure. ${words(n)} Monitoring showed the spike.`;
const sequence = (...replies: string[]): Chat & { prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  const chat = (async (m) => (prompts.push(m.map((x) => x.content).join('\n')), replies[Math.min(i++, replies.length - 1)]!)) as Chat & { prompts: string[] };
  chat.prompts = prompts;
  return chat;
};

test('a chapter is 150 to 250 words, has no heading, and names every concept of its card', async () => {
  const r = await writeChapter(sequence(chapter(190)), input());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(wordCount(r.body) >= 150 && wordCount(r.body) <= 250);
  assert.equal(r.title, 'The first page at 3am');
});

test('a chapter that is too long or too short, or misses a concept, is rewritten once with the reason; a second failure is reported', async () => {
  const chat = sequence(chapter(400), chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1]!, /too long|250 words/i);
  const missing = sequence(`${words(190)} only about something else`, `${words(190)} still nothing relevant`);
  const bad = await writeChapter(missing, input());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /observability|debugging|concept/i);
});

test('the prompt carries the bible, the outline entry, the earlier chapters, the verified facts and each concept\'s main name; facts are the only source of specifics', async () => {
  const chat = sequence(chapter(190));
  await writeChapter(chat, input());
  const p = chat.prompts[0]!;
  for (const piece of ['A payments team', 'Sam, the newest engineer on call', 'The first page at 3am', 'Before the pager', 'Reproduce the failure before changing anything.', 'observability']) assert.ok(p.includes(piece), piece);
  assert.match(p, /only the facts|use only/i);
  assert.match(p, /never follow instructions/i);
});

test('a reused concept supplies its verified facts as fixed input, marked so the writer keeps them as they are', async () => {
  const chat = sequence(chapter(190));
  await writeChapter(chat, input({ concepts: [{ name: 'debugging', terms: ['debugging'], facts: ['Reproduce the failure first.'], reused: true }, { name: 'observability', terms: ['monitoring'], facts: [], reused: false }] }));
  assert.match(chat.prompts[0]!, /already verified[\s\S]*Reproduce the failure first\./i);
});

test('a chapter that touches a personal characteristic fails the screen and is rewritten once', async () => {
  const chat = sequence(`${chapter(190)} Sam, a young woman from Lagos, nodded.`, chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.equal(chat.prompts.length, 2);
});

test('a model that fails twice is reported as a failure, not a half chapter', async () => {
  const r = await writeChapter(async () => { throw new Error('down'); }, input());
  assert.equal(r.ok, false);
});

test('a scenario concept counts as named when the chapter uses most of its key words, not only the whole phrase', async () => {
  const scenario = input({ concepts: [{ name: 'debug / diagnose and resolve production incidents', terms: ['debug / diagnose and resolve production incidents'], facts: [], reused: false }] });
  const body = `Sam had to diagnose a production incident and resolve it before the morning, so Sam started to debug the failing service. ${words(170)}`;
  assert.equal((await writeChapter(sequence(body), scenario)).ok, true);
  const unrelated = await writeChapter(sequence(`Sam planned the sprint and tidied the board. ${words(170)}`, `Sam planned the sprint again. ${words(170)}`), scenario);
  assert.equal(unrelated.ok, false);
});

test('only the first four facts of a concept go into the prompt, so the chapter is not stuffed with them', async () => {
  const facts = Array.from({ length: 9 }, (_, i) => `Fact number ${i} about debugging.`);
  const chat = sequence(chapter(190));
  await writeChapter(chat, input({ concepts: [{ name: 'debugging', terms: ['debugging', 'debug'], facts, reused: false }, { name: 'observability', terms: ['observability', 'monitoring'], facts: [], reused: false }] }));
  assert.match(chat.prompts[0]!, /Fact number 3 about debugging/);
  assert.doesNotMatch(chat.prompts[0]!, /Fact number 4 about debugging/);
});

test('length is mechanical, so there are up to three attempts for it, and each retry is told how long the last one was', async () => {
  const chat = sequence(chapter(500), chapter(400), chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.equal(chat.prompts.length, 3);
  assert.match(chat.prompts[1]!, /5\d\d words/);
  assert.match(chat.prompts[2]!, /4\d\d words/);
  const never = await writeChapter(sequence(chapter(500)), input());
  assert.equal(never.ok, false);
});

test('a concept is named when the chapter uses its singular or plural form', async () => {
  const c = input({ concepts: [{ name: 'distributed systems', terms: ['distributed systems'], facts: [], reused: false }, { name: 'api development', terms: ['api development'], facts: [], reused: false }] });
  const body = `Sam designed the service as a distributed system with an api for development teams to call. ${words(170)}`;
  assert.equal((await writeChapter(sequence(body), c)).ok, true);
});

test('a two-word concept is named when its head noun is used: "documentation" names "technical documentation", but "data" alone does not name "data pipelines"', async () => {
  const doc = input({ concepts: [{ name: 'technical documentation', terms: ['technical documentation'], facts: [], reused: false }, { name: 'api development', terms: ['api development'], facts: [], reused: false }] });
  assert.equal((await writeChapter(sequence(`Sam kept the documentation current while shaping the api development plan. ${words(170)}`), doc)).ok, true);
  const data = input({ concepts: [{ name: 'data pipelines', terms: ['data pipelines'], facts: [], reused: false }, { name: 'api development', terms: ['api development'], facts: [], reused: false }] });
  assert.equal((await writeChapter(sequence(`Sam looked at the data for the api development plan. ${words(170)}`), data)).ok, false);
});

test('her is a gendered pronoun too', async () => {
  const chat = sequence(`${chapter(190)} Sam asked the lead about her notes.`, `${chapter(190)} Sam asked the lead about the notes.`);
  const r = await writeChapter(chat, input());
  assert.equal(r.ok && !/\bher\b/i.test(r.body), true);
  assert.equal(chat.prompts.length, 2);
});

test('a chapter that refers to the character as he or she is written again with the reason; the name or "they" is used', async () => {
  const chat = sequence(`${chapter(190)} She checked the logs.`, `${chapter(190)} Sam checked the logs.`);
  const r = await writeChapter(chat, input());
  assert.equal(r.ok && !/\bshe\b/i.test(r.body), true);
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1]!, /gendered pronoun/i);
  assert.match(chat.prompts[0]!, /never refer to a character as he, she/i);
});

const one = (name: string) => input({ concepts: [{ name, terms: [name], facts: [], reused: false }] });

test('a long scenario phrase is named when the chapter uses its main words in singular or plural: "pipeline" names "pipelines", "release" names "releases", "ensures" names "ensure"', async () => {
  const phrase = one('implement ci/cd pipelines for ml code and model releases');
  assert.equal((await writeChapter(sequence(`Sam sets up a pipeline that tests the ML code and ships each model release. ${words(170)}`), phrase)).ok, true);
  const ensure = one('ensure models follow responsible and explainable ai practices');
  assert.equal((await writeChapter(sequence(`Sam ensures every model stays explainable and responsible before it ships. ${words(170)}`), ensure)).ok, true);
});

test('a long scenario phrase needs half of its main words; one shared word, or short phrases with less than 60%, still do not name a concept', async () => {
  const ensure = one('ensure models follow responsible and explainable ai practices');
  assert.equal((await writeChapter(sequence(`Sam trained a model on fresh data. ${words(170)}`), ensure)).ok, false);
  const short = one('data quality checks');
  assert.equal((await writeChapter(sequence(`Sam looked at the data for the plan. ${words(170)}`), short)).ok, false);
});

const regulatory = (over: Partial<ChapterInput> = {}) => input({
  concepts: [{ name: 'regulatory compliance', terms: ['regulatory compliance', 'kyc/aml compliance', 'privacy and compliance'], facts: ['Define the product classification and regulatory pathway early.', 'Review the regulatory strategy on a regular schedule.'], reused: false }],
  ...over,
});
const regChapter = (n: number, term = 'regulatory compliance') => `Sam started the week on ${term}. ${words(n)} Then Sam wrote down what worked.`;

test('the writer is shown only each concept\'s main name, never the list of alternate terms', async () => {
  const chat = sequence(regChapter(190));
  const r = await writeChapter(chat, regulatory());
  assert.equal(r.ok, true);
  assert.match(chat.prompts[0]!, /regulatory compliance/);
  assert.doesNotMatch(chat.prompts[0]!, /kyc\/aml|privacy and compliance|terms:/);
});

test('the check that a chapter names its concept still accepts any alternate term, not only the main name', async () => {
  const viaAlternate = await writeChapter(sequence(regChapter(190, 'kyc/aml compliance')), regulatory());
  assert.equal(viaAlternate.ok, true);
  const viaOther = await writeChapter(sequence(regChapter(190, 'privacy and compliance')), regulatory());
  assert.equal(viaOther.ok, true);
  const none = await writeChapter(sequence(`${words(190)} nothing relevant here`, `${words(190)} still nothing`, `${words(190)} nope`), regulatory());
  assert.equal(none.ok, false);
});

test('a concept\'s stored facts still reach the writer unchanged', async () => {
  const chat = sequence(regChapter(190));
  await writeChapter(chat, regulatory());
  assert.match(chat.prompts[0]!, /Define the product classification and regulatory pathway early\./);
  assert.match(chat.prompts[0]!, /Review the regulatory strategy on a regular schedule\./);
});

test('the writer is told to add no legal, regulatory, security or financial specifics beyond the facts, and to describe the rest in plain general terms', async () => {
  const chat = sequence(regChapter(190));
  await writeChapter(chat, regulatory());
  assert.match(chat.prompts[0]!, /no legal, regulatory, security or financial specifics beyond the facts/i);
  assert.match(chat.prompts[0]!, /plain, general terms/i);
});

test('the writer is told the exact names to use, and the first prompt lists them', async () => {
  const chat = sequence(chapter(190));
  await writeChapter(chat, input());
  assert.match(chat.prompts[0]!, /Use these names exactly as written: debugging; observability/);
  assert.match(chat.prompts[0]!, /exact name[\s\S]*appear[\s\S]*not (replace|paraphrase)|do not replace the name with a paraphrase/i);
});

test('when a concept\'s name is missing, the retry quotes the exact words to put in', async () => {
  const chat = sequence(`Sam opened the debugging notes and began to debug. ${words(190)} Nothing else was said.`, chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.match(chat.prompts[1]!, /never names the concept "observability" \(use the exact words "observability"\)/);
});

test('a chapter with many concepts gets at most eight facts in all, and every concept keeps at least two, so naming them all fits in the length', async () => {
  const concept = (name: string) => ({ name, terms: [name], facts: Array.from({ length: 6 }, (_, i) => `Fact ${i} about ${name}.`), reused: false });
  const bullets = (prompt: string) => (prompt.match(/^\s+\* /gm) ?? []).length;
  const three = sequence(`alpha beta gamma ${words(190)}`);
  await writeChapter(three, input({ concepts: [concept('alpha'), concept('beta'), concept('gamma')] }));
  assert.equal(bullets(three.prompts[0]!), 6, 'three concepts: two facts each');
  for (const n of ['alpha', 'beta', 'gamma']) assert.match(three.prompts[0]!, new RegExp(`Fact 1 about ${n}`));
  assert.doesNotMatch(three.prompts[0]!, /Fact 2 about alpha/);
  const two = sequence(`alpha beta ${words(190)}`);
  await writeChapter(two, input({ concepts: [concept('alpha'), concept('beta')] }));
  assert.equal(bullets(two.prompts[0]!), 8, 'two concepts: four facts each');
  const four = sequence(`alpha beta gamma delta ${words(190)}`);
  await writeChapter(four, input({ concepts: [concept('alpha'), concept('beta'), concept('gamma'), concept('delta')] }));
  assert.equal(bullets(four.prompts[0]!), 8, 'four concepts: two facts each');
});

// One character carries the whole course: every chapter uses the bible's first name, and none brings in another person.
test('a chapter that never uses the character\'s name is rewritten with the name quoted', async () => {
  const noName = `The engineer opened the debugging notes and began to debug the failure. ${words(190)} Monitoring showed the spike.`;
  const chat = sequence(noName, chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1]!, /never uses the character's name "Sam"/);
  assert.match(chat.prompts[0]!, /every chapter .*character'?s? .*first name/i);
});

test('a chapter that brings in a different named person is rewritten with that name quoted, and a second failure is reported', async () => {
  const other = `Sam opened the debugging notes and began to debug the failure. Alex, the product manager, joined them. ${words(180)} Alex then reviewed the spike.`;
  const chat = sequence(other, chapter(190));
  const r = await writeChapter(chat, input());
  assert.equal(r.ok, true);
  assert.match(chat.prompts[1]!, /another person \(Alex\)/);
  const bad = await writeChapter(sequence(other, other), input());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /Alex/);
});

test('sentence openers, company names from the facts and words from the concepts are not mistaken for people', async () => {
  const body = `Sam opened the debugging notes and began to debug the failure. Next, Sam read how Netflix keeps services apart. Finally, Throughout the week Sam watched the Observability board. Then Sam wrote it all down. ${words(150)}`;
  const r = await writeChapter(sequence(body), input({ concepts: [{ name: 'debugging', terms: [], facts: ['Netflix runs independent services.'], reused: false }, { name: 'observability', terms: [], facts: [], reused: false }] }));
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});
