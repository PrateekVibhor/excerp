import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { deriveIndustry, industryForConcept, strongestAlternate } from './domain.ts';

test('the industry phrase comes from one small call over the companies and titles, and is trimmed to a short phrase', async () => {
  let seen = '';
  const chat: Chat = async (m) => (seen = m.at(-1)!.content, JSON.stringify({ industry: '  fintech and payroll software\nand more  ' }));
  const r = await deriveIndustry(chat, [{ company: 'Coinbase', title: 'Product Manager II' }, { company: 'Justworks', title: 'Senior Product Manager' }]);
  assert.match(seen, /Coinbase/);
  assert.match(seen, /Senior Product Manager/);
  assert.equal(r, 'fintech and payroll software');
});

test('a failed or unusable answer, or no postings, means no domain, never an error', async () => {
  assert.equal(await deriveIndustry(async () => { throw new Error('down'); }, [{ company: 'A', title: 'B' }]), '');
  assert.equal(await deriveIndustry(async () => 'not json', [{ company: 'A', title: 'B' }]), '');
  assert.equal(await deriveIndustry(async () => JSON.stringify({ industry: 5 }), [{ company: 'A', title: 'B' }]), '');
  let called = 0;
  assert.equal(await deriveIndustry(async () => (called++, '{}'), []), '');
  assert.equal(called, 0);
});

test('the strongest alternate term is the shortest other term that adds a word the concept name lacks', () => {
  assert.equal(strongestAlternate('regulatory compliance', ['privacy and compliance', 'kyc/aml compliance', 'regulatory compliance', 'regulatory awareness fintech healthcare hrtech']), 'kyc/aml compliance');
  assert.equal(strongestAlternate('python', ['python', 'python programming']), 'python programming');
  assert.equal(strongestAlternate('python', ['python']), undefined);
  assert.equal(strongestAlternate('machine learning', ['learning machine', 'ML']), 'ML');
});

const askedAbout = (log: string[], phrase = (companies: string) => (/Justworks|Coinbase|Intuit/.test(companies) ? 'fintech and payroll software' : 'general business software')): Chat => async (m) => {
  const companies = m.at(-1)!.content;
  log.push(companies);
  return JSON.stringify({ industry: phrase(companies) });
};
const asked = { company: 'Justworks', title: 'Senior Product Manager' };
const others = [{ company: 'Esri', title: 'Sr. Product Manager' }, { company: 'Tegna', title: 'Technology Product Manager' }, { company: 'Amazon', title: 'Sr. Product Manager Tech' }];

test('a concept whose postings are all one industry gets a sharp phrase from only those postings', async () => {
  const log: string[] = [];
  const r = await industryForConcept(askedAbout(log), [asked, { company: 'Coinbase', title: 'Product Manager II' }, { company: 'Intuit', title: 'Group Product Manager' }], async () => 'technology');
  assert.equal(r, 'fintech and payroll software');
  assert.equal(log.length, 1);
  assert.ok(!/Esri|Tegna|Amazon/.test(log[0]!), 'the other companies in the pool are not sent');
});

test('a concept with mixed postings is asked about its own postings only, so its phrase is not the whole-course blend', async () => {
  const log: string[] = [];
  const r = await industryForConcept(askedAbout(log), [asked, others[0]!], async () => 'technology');
  assert.ok(r !== 'technology' && r.length > 0);
  assert.match(log[0]!, /Justworks/);
  assert.match(log[0]!, /Esri/);
  assert.ok(!/Tegna|Amazon/.test(log[0]!));
});

test('a concept with no postings uses the course-level phrase and makes no call of its own', async () => {
  const log: string[] = [];
  assert.equal(await industryForConcept(askedAbout(log), [], async () => 'technology'), 'technology');
  assert.equal(log.length, 0);
});

test('a failed, unusable or empty answer for the concept falls back to the course-level phrase, and to empty if that is empty too; never an error', async () => {
  assert.equal(await industryForConcept(async () => { throw new Error('down'); }, [asked], async () => 'technology'), 'technology');
  assert.equal(await industryForConcept(async () => 'not json', [asked], async () => 'technology'), 'technology');
  assert.equal(await industryForConcept(async () => JSON.stringify({ industry: '' }), [asked], async () => 'technology'), 'technology');
  assert.equal(await industryForConcept(async () => { throw new Error('down'); }, [asked], async () => ''), '');
  assert.equal(await industryForConcept(async () => { throw new Error('down'); }, [], async () => ''), '');
});
