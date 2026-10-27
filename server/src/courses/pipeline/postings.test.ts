import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { findPostings, type Hit, type SearchClient, type SearchParams } from './postings.ts';

const body = 'Responsibilities: you will build and run things for customers. Qualifications: experience with systems. '.repeat(14);
const hit = (url: string, title: string, text = body): Hit => ({ url, title, text });
const companies = Array.from({ length: 12 }, (_, i) => ({ employer: `Acme ${i}`, domains: [`acme${i}.com`] }));

/** A fake search: answers by a function of the parameters and records every call. */
function fakeSearch(answer: (p: SearchParams) => Hit[]) {
  const calls: SearchParams[] = [];
  const client: SearchClient = { search: async (p) => (calls.push(p), answer(p)) };
  return { client, calls };
}
const credits = () => { const used = { n: 0 }; return { used, io: { credits: (n: number) => void (used.n += n), tokens: () => {} } }; };
const judge = (same: boolean): Chat => async () => JSON.stringify({ same, why: 'test' });
const run = (answer: (p: SearchParams) => Hit[], over: { chat?: Chat; aliases?: string[]; minPostings?: number } = {}) => {
  const s = fakeSearch(answer);
  const c = credits();
  return { s, c, result: findPostings({ role: 'ML engineer', aliases: over.aliases ?? ['machine learning engineer'], companies, search: s.client, chat: over.chat ?? judge(true), io: c.io, minPostings: over.minPostings }) };
};

test('searches the tracked companies in groups plus the shared application systems, one credit each', async () => {
  const { s, c, result } = run(() => []);
  await result;
  const withDomains = s.calls.filter((x) => x.includeDomains);
  assert.ok(withDomains.length >= 2, 'grouped tracked searches and one application-system search');
  const grouped = withDomains.flatMap((x) => x.includeDomains!).filter((d) => d.startsWith('acme'));
  assert.deepEqual([...new Set(grouped)].sort(), companies.flatMap((c) => c.domains).sort(), 'every tracked domain is searched once');
  assert.ok(withDomains.some((x) => x.includeDomains!.includes('lever.co')), 'application systems are searched');
  assert.equal(c.used.n, s.calls.length);
});

test('exact and alias titles are kept with the exact title they use', async () => {
  const { result } = run((p) => (p.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'Machine Learning Engineer, Vision'), hit('https://acme1.com/careers/job/2', 'ML Engineer')] : []));
  const r = await result;
  assert.deepEqual(r.matched.map((m) => [m.employer, m.match, m.title]).sort(), [['Acme 0', 'alias', 'Machine Learning Engineer, Vision'], ['Acme 1', 'exact', 'ML Engineer']]);
});

test('a similar title is kept only if the judge says it is the same job, otherwise it is listed as not used', async () => {
  const answer = (p: SearchParams) => (p.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'Software Engineer, ML Platform')] : []);
  const yes = await run(answer, { chat: judge(true) }).result;
  assert.deepEqual(yes.matched.map((m) => m.match), ['similar-approved']);
  const no = await run(answer, { chat: judge(false) }).result;
  assert.equal(no.matched.length, 0);
  assert.deepEqual(no.notUsed.map((n) => n.reason), ['title only resembles the role']);
});

test('a judge that fails leaves the posting as not used instead of failing the search', async () => {
  const r = await run((p) => (p.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'Software Engineer, ML Platform')] : []), { chat: async () => { throw new Error('model down'); } }).result;
  assert.equal(r.matched.length, 0);
  assert.equal(r.notUsed.length, 1);
});

test('boards, pages that are not postings, and different roles never count', async () => {
  const r = await (run((p) => !p.includeDomains?.includes('acme0.com') ? [] : [
    hit('https://www.indeed.com/viewjob?jk=1', 'ML Engineer'),
    hit('https://acme0.com/careers/job/9', 'ML Engineer', 'short'),
    hit('https://acme2.com/careers/job/3', 'Marketing Manager'),
  ]).result);
  assert.equal(r.matched.length, 0);
  assert.deepEqual(r.notUsed.map((n) => n.reason), ['title is a different role']);
  assert.ok(r.dropped.denylisted >= 1 && r.dropped.notPosting >= 1);
});

test('one posting per employer, and the others are kept as fallbacks', async () => {
  const r = await run((p) => (p.includeDomains?.includes('acme0.com') ? [hit('https://acme0.com/careers/job/1', 'ML Engineer'), hit('https://acme0.com/careers/job/2', 'Senior ML Engineer'), hit('https://acme0.com/careers/job/3', 'Staff ML Engineer')] : [])).result;
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0]!.alts.length, 2);
  assert.ok(r.notUsed.some((n) => n.reason === 'second posting from the same employer'));
});

test('the open-web top-up runs only below the minimum, and stops once it is reached', async () => {
  const many = (p: SearchParams) => (p.includeDomains ? companies.slice(0, 9).map((c, i) => hit(`https://${c.domains[0]}/careers/job/${i}`, 'ML Engineer')) : []);
  const enough = run(many);
  await enough.result;
  assert.ok(!enough.s.calls.some((c) => c.excludeDomains), 'nine matches need no open-web search');
  const few = run((p) => (p.excludeDomains ? [hit('https://careers.openco.com/job/1', 'ML Engineer')] : []));
  const r = await few.result;
  assert.ok(few.s.calls.some((c) => c.excludeDomains && c.excludeDomains.length > 50), 'the open-web search excludes the denylist');
  assert.equal(r.matched.length, 1);
  assert.ok(few.s.calls.filter((c) => c.excludeDomains).length <= 3, 'at most three top-ups');
});

test('a search that throws costs nothing more and the others still count', async () => {
  let n = 0;
  const r = await run(() => { if (++n === 1) throw new Error('rate limit'); return [hit('https://acme3.com/careers/job/1', 'ML Engineer')]; }).result;
  assert.equal(r.matched.length, 1);
});
