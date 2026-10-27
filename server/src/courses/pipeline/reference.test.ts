import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import type { Hit, SearchClient, SearchParams } from './postings.ts';
import { referenceFor, topUpResources, type ReferenceInput } from './reference.ts';
import type { YoutubeClient } from './video.ts';
import type { VideoMeta } from './videoScreen.ts';

const TEXT_A = 'Precision is the share of predicted positives that are correct. Recall measures how many actual positives were found. '.repeat(3);
const TEXT_B = 'Precision is the share of predicted positives that are correct. A confusion matrix counts true and false positives. '.repeat(3);
const page = (url: string, title: string, text = TEXT_A): Hit => ({ url, title, text });
const vid = (id: string): VideoMeta => ({ id, title: `Video ${id}`, channel: `Chan ${id}`, channelId: id, publishedAt: '2025-08-01T00:00:00Z', duration: 'PT20M', views: 50_000, likes: 800, captions: true, language: 'en' });
const NOW = new Date('2026-10-20T00:00:00Z');

function setup(over: { first?: Hit[]; second?: Hit[]; videos?: VideoMeta[]; unreachable?: string[]; keepVideos?: boolean; facts?: object[] } = {}) {
  const calls: SearchParams[] = [];
  const credits = { n: 0 };
  const search: SearchClient = { search: async (p) => (calls.push(p), calls.length === 1 ? over.first ?? [] : over.second ?? []) };
  const chat: Chat = async (m) => {
    const system = m[0]!.content;
    if (/web page is a good source/.test(system)) return JSON.stringify({ keep: true, kind: /primary-doc/.test(m.at(-1)!.content) ? 'primary' : 'secondary', why: 'a clear explanation' });
    if (/List the facts/.test(system)) return JSON.stringify({ facts: over.facts ?? [{ text: 'Precision is the share of predicted positives that are correct.', kind: 'definition' }, { text: 'Recall measures how many actual positives were found.', kind: 'definition' }] });
    return JSON.stringify({ keep: over.keepVideos !== false, why: 'a practitioner explaining their work' });
  };
  const youtube: YoutubeClient = { search: async () => (over.videos ?? []).map((v) => v.id), videos: async (ids) => (over.videos ?? []).filter((v) => ids.includes(v.id)) };
  const input: ReferenceInput = { role: 'ML engineer', concept: 'model evaluation', search, chat, youtube, reachable: async (u) => !(over.unreachable ?? []).includes(u), io: { credits: (n) => void (credits.n += n), tokens: () => {} }, now: NOW };
  return { input, calls, credits };
}

test('a concept gets two to four resources, mixing articles or blogs with videos', async () => {
  const { input } = setup({ first: [page('https://a.example.org/x', 'A guide'), page('https://b.other.com/y', 'Another', TEXT_B), page('https://c.third.net/z', 'Third')], videos: [vid('v1'), vid('v2'), vid('v3')] });
  const r = await referenceFor(input);
  assert.ok(r.resources.length >= 2 && r.resources.length <= 4);
  assert.ok(r.resources.some((x) => x.kind === 'video'));
  assert.ok(r.resources.some((x) => x.kind !== 'video'));
  assert.ok(r.resources.filter((x) => x.kind === 'video').length <= 2);
  assert.ok(r.resources.every((x) => x.title && x.url && x.why));
});

test('when no video passes the rules the resources are articles and blogs only, still at least two', async () => {
  const { input } = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B)], videos: [vid('v1')], keepVideos: false });
  const r = await referenceFor(input);
  assert.deepEqual([...new Set(r.resources.map((x) => x.kind))].filter((k) => k === 'video'), []);
  assert.ok(r.resources.length >= 2);
});

test('an unreachable page is replaced by the next candidate', async () => {
  const { input } = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B), page('https://c.third.net/z', 'C')], unreachable: ['https://a.example.org/x'] });
  const r = await referenceFor(input);
  assert.ok(!r.resources.some((x) => x.url === 'https://a.example.org/x'));
  assert.ok(r.resources.length >= 2);
});

test('fewer than two resources is reported as a shortfall and not hidden', async () => {
  const { input } = setup({ first: [page('https://a.example.org/x', 'A')] });
  const r = await referenceFor(input);
  assert.equal(r.shortfall, true);
});

test('facts that need two independent publishers trigger one more search; with the second publisher they are kept', async () => {
  const one = setup({ first: [page('https://a.example.org/x', 'A')], second: [page('https://b.other.com/y', 'B', TEXT_B)] });
  const r = await referenceFor(one.input);
  assert.equal(one.calls.length, 2);
  assert.equal(one.credits.n, 2);
  assert.deepEqual(r.facts.map((f) => f.text), ['Precision is the share of predicted positives that are correct.']);
  assert.equal(r.droppedFacts.length, 1); // "recall" is still stated by one publisher only
});

test('one search is enough when the facts already have two publishers, and the result never carries a criticality', async () => {
  const two = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B + TEXT_A)] });
  const r = await referenceFor(two.input);
  assert.equal(two.calls.length, 1);
  assert.equal(two.credits.n, 1);
  assert.ok(!('criticality' in r) && !JSON.stringify(r).includes('criticality'));
});

test('every page used for a fact is named, so a later source error can be traced to the chapters that used it', async () => {
  const { input } = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B + TEXT_A)] });
  const r = await referenceFor(input);
  assert.ok(r.facts.every((f) => f.sources.length >= 2));
  assert.ok(r.groundingPages.some((u) => u === 'https://a.example.org/x'));
});

test('with no domain and no alternate term the queries are exactly what they were', async () => {
  const { input, calls } = setup({ first: [page('https://a.example.org/x', 'A')], second: [page('https://b.other.com/y', 'B', TEXT_B)] });
  await referenceFor(input);
  assert.equal(calls[0]!.query, 'model evaluation for a ML engineer: explanation and best practices');
  assert.equal(calls[1]!.query, 'model evaluation ML engineer definition standard reference');
});

test('both research queries carry the industry phrase and the concept\'s strongest alternate term', async () => {
  const { input, calls } = setup({ first: [page('https://a.example.org/x', 'A')], second: [page('https://b.other.com/y', 'B', TEXT_B)] });
  await referenceFor({ ...input, domain: 'fintech', alternate: 'kyc/aml compliance' });
  assert.equal(calls[0]!.query, 'model evaluation (kyc/aml compliance) for a ML engineer in fintech: explanation and best practices');
  assert.equal(calls[1]!.query, 'model evaluation (kyc/aml compliance) ML engineer fintech definition standard reference');
});

test('the page judge and the fact extractor are told the industry and to reject a different industry or kind of product', async () => {
  const systems: string[] = [];
  const base = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B + TEXT_A)] });
  const chat: Chat = async (m) => (systems.push(m[0]!.content + '\n' + m.at(-1)!.content), base.input.chat(m));
  await referenceFor({ ...base.input, chat, domain: 'fintech and payroll software' });
  const judge = systems.filter((s) => /web page is a good source/.test(s));
  const extract = systems.filter((s) => /List the facts/.test(s));
  assert.ok(judge.length > 0 && judge.every((s) => /fintech and payroll software/.test(s) && /different industry or kind of product/.test(s)));
  assert.ok(extract.length > 0 && extract.every((s) => /fintech and payroll software/.test(s) && /different industry or kind of product/.test(s)));
  const plain: string[] = [];
  const base2 = setup({ first: [page('https://a.example.org/x', 'A'), page('https://b.other.com/y', 'B', TEXT_B + TEXT_A)] });
  await referenceFor({ ...base2.input, chat: async (m) => (plain.push(m[0]!.content), base2.input.chat(m)) });
  assert.ok(plain.every((s) => !/different industry/.test(s)), 'without a domain the prompts are unchanged');
});

// A concept left under two resources is topped up with one more live search, for resources only: no facts are taken from it.
test('top-up: a short concept gets one search, one credit, and the kept pages added after what it has', async () => {
  const { input, calls, credits } = setup({ first: [page('https://new.example.org/a', 'New guide'), page('https://have.example.org/x', 'Already there')] });
  const have = [{ kind: 'article' as const, title: 'Library page', source: 'lib.example.org', url: 'https://have.example.org/x', why: 'w' }];
  const r = await topUpResources({ ...input, have });
  assert.equal(calls.length, 1);
  assert.equal(credits.n, 1);
  assert.deepEqual(r.map((x) => x.url), ['https://have.example.org/x', 'https://new.example.org/a'], 'an address it already has is not added twice');
});

test('top-up: nothing is searched when the concept already has two, and unreachable pages are not added', async () => {
  const two = [0, 1].map((i) => ({ kind: 'article' as const, title: `t${i}`, source: 's', url: `https://h${i}.example.org/`, why: 'w' }));
  const a = setup({ first: [page('https://new.example.org/a', 'New')] });
  assert.deepEqual(await topUpResources({ ...a.input, have: two }), two);
  assert.equal(a.credits.n, 0);
  const b = setup({ first: [page('https://dead.example.org/a', 'Dead')], unreachable: ['https://dead.example.org/a'] });
  assert.deepEqual(await topUpResources({ ...b.input, have: [] }), []);
  assert.equal(b.credits.n, 1);
});

test('top-up: never more than four in all, and a failed search leaves what there was', async () => {
  const have = [{ kind: 'video' as const, title: 'v', source: 'c', url: 'https://youtu.be/1', why: 'w' }];
  const many = setup({ first: [1, 2, 3, 4, 5].map((i) => page(`https://n${i}.example.org/`, `N${i}`)) });
  assert.equal((await topUpResources({ ...many.input, have })).length, 4);
  const failing = setup();
  failing.input.search = { search: async () => { throw new Error('down'); } };
  assert.deepEqual(await topUpResources({ ...failing.input, have }), have);
});
