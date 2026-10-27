import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestSpan, catchRate, overlaps } from './r2Logic.ts';

const source = 'A product roadmap shows the plan for a product over time. Teams review the roadmap every quarter with stakeholders. Prioritization frameworks such as RICE score ideas on reach, impact, confidence and effort.';

test('a claim copied from the source is supported and returns the matching span', () => {
  const r = bestSpan('Teams review the roadmap every quarter with stakeholders.', source);
  assert.equal(r.supported, true);
  assert.match(r.span, /review the roadmap every quarter/);
});

test('a plural or other simple variation of the words still matches', () => {
  assert.equal(bestSpan('A roadmap shows the plans for a product over time.', source).supported, true);
});

test('a claim whose number is not in the matching span is unsupported even when the words overlap', () => {
  assert.equal(bestSpan('Teams review the roadmap every six quarters with stakeholders.', source).supported, false);
  assert.equal(bestSpan('RICE scores ideas on 7 factors: reach, impact, confidence and effort.', source).supported, false);
});

test('a claim about something the source never mentions is unsupported', () => {
  assert.equal(bestSpan('Employers must keep payroll records for seven years.', source).supported, false);
});

test('a claim spread over two neighbouring sentences can be supported', () => {
  assert.equal(bestSpan('A roadmap shows the plan over time and teams review it every quarter.', source).supported, true);
});

test('overlaps: the planted sentence is found inside a longer flagged claim, and unrelated text is not', () => {
  assert.equal(overlaps('Retirement withdrawals before 59 and a half never carry a penalty', 'Withdrawals before 59 and a half never carry a penalty.'), true);
  assert.equal(overlaps('Teams review the roadmap every quarter', 'Withdrawals before 59 and a half never carry a penalty.'), false);
});

test('catchRate counts planted claims matched by at least one flag, per category', () => {
  const planted = [
    { id: 'p1', category: 'law', sentence: 'Employers need not keep payroll records.' },
    { id: 'p2', category: 'law', sentence: 'Gifts above any amount are always allowed.' },
    { id: 'p3', category: 'money', sentence: 'Index funds never lose value.' },
  ];
  const flags = [{ chapter: 'c1', text: 'employers need not keep payroll records' }, { chapter: 'c3', text: 'index funds never lose value' }];
  const r = catchRate(planted.map((p, i) => ({ ...p, chapter: i === 0 ? 'c1' : i === 1 ? 'c2' : 'c3' })), flags);
  assert.deepEqual(r.overall, { caught: 2, total: 3 });
  assert.deepEqual(r.byCategory.law, { caught: 1, total: 2 });
  assert.deepEqual(r.missed, ['p2']);
});
