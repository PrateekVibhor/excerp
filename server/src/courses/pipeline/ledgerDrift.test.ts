import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { checkChapter, driftedClaims, verifyDrift, gateReasons } from './accuracy.ts';

const ledger = [
  { concept: 'retention', claim: 'Employers must keep payroll records for three years.', category: 'law' as const },
  { concept: 'sql', claim: 'An index speeds up reads on the indexed column.', category: null },
];

test('a re-narrated claim that still matches its ledger entry is not drift', () => {
  assert.deepEqual(driftedClaims(['Payroll records have to be kept by employers for three years.', 'Reads on an indexed column get faster with an index.'], ledger), []);
});

test('a reused claim altered in the retelling is caught when the number changes or the meaning is negated, even when the topic words are the same', () => {
  const d = driftedClaims(['Employers must keep payroll records for seven years.', 'An index never speeds up reads on the indexed column.'], ledger);
  assert.deepEqual(d.map((x) => x.ledgerClaim.concept).sort(), ['retention', 'sql']);
});

test('the pure check cannot see a one-word swap (reads for writes); the QA agent is given the ledger entries so it can', async () => {
  assert.deepEqual(driftedClaims(['An index speeds up writes on the indexed column.'], ledger), []);
  let prompt = '';
  const chat: Chat = async (m) => (/fact-checker/.test(m[0]!.content) && (prompt = m[0]!.content + m.at(-1)!.content), /You compare one claim/.test(m[0]!.content) ? JSON.stringify({ differs: true }) : JSON.stringify({ claims: [{ text: 'An index speeds up writes on the indexed column.', verdict: 'contradicted', category: null, quote: 'An index speeds up reads on the indexed column.' }] }));
  const r = await checkChapter(chat, { role: 'r', chapter: 'An index speeds up writes on the indexed column.', pages: [], ledger });
  assert.match(prompt, /already verified[\s\S]*An index speeds up reads on the indexed column\./i);
  assert.ok(r.ok && r.claims[0]!.verdict === 'contradicted');
});

test('a claim about something else is not compared with the ledger', () => {
  assert.deepEqual(driftedClaims(['The pager rotation changes every Monday.'], ledger), []);
});

test('drift on a law, safety, money or health entry is reported as such', () => {
  const d = driftedClaims(['Employers must keep payroll records for seven years.'], ledger);
  assert.equal(d[0]!.ledgerClaim.category, 'law');
});

test('a claim that retells one ledger entry faithfully is not drift against a different entry on the same topic', () => {
  const entries = [
    { concept: 'agile', claim: 'The sprint planning meeting is attended by the Product Owner, Scrum Master, and the development team.', category: null },
    { concept: 'agile', claim: 'Iteration Planning attendees are the Agile Team, facilitated by the Scrum Master.', category: null },
  ];
  assert.deepEqual(driftedClaims([entries[0]!.claim], entries), []);
});

test('a paraphrase that keeps the numbers and the negation is not drift, however different its words', () => {
  const entries = [
    { concept: 'testing', claim: 'In unit testing, dependencies are typically mocked or stubbed out to isolate the unit under test.', category: null },
    { concept: 'algorithms', claim: 'Algorithms must be language independent.', category: null },
  ];
  assert.deepEqual(driftedClaims(['In unit testing, external calls are replaced with mocks or stubs to isolate the unit under test.', 'Algorithms are language-independent recipes for solving problems.'], entries), []);
});

test('a changed or added number, or a negation added or removed, is still drift', () => {
  const entries = [{ concept: 'retention', claim: 'Employers must keep payroll records for three years.', category: 'law' as const }];
  assert.equal(driftedClaims(['Employers keep payroll records for seven years.'], entries).length, 1);
  assert.equal(driftedClaims(['Employers need not keep payroll records for three years.'], entries).length, 1);
  assert.equal(driftedClaims(['Employers keep payroll records and replace them after 5 years.'], entries).length, 1);
});

test('a number spelled out in words is the same number as its digits: twenty is 20, five times is 5×', () => {
  const entries = [
    { concept: 'docs', claim: 'Audit existing pages to identify the top 20 questions new engineers ask in their first 30 days.', category: null },
    { concept: 'cassandra', claim: 'Zero Copy Streaming can be up to 5× faster than traditional streaming.', category: null },
  ];
  assert.deepEqual(driftedClaims(['Sam audits pages to find the top twenty questions new engineers ask in their first thirty days.', 'Zero Copy Streaming can reach up to five times the speed of traditional streaming.'], entries), []);
  assert.equal(driftedClaims(['Sam audits pages to find the top fifty questions new engineers ask in their first thirty days.'], entries).length, 1);
});

const entry = [{ concept: 'fusion', claim: 'Sensor fusion data collection, preprocessing, alignment, fusion and decision-making are the steps.', category: null }];
const said = (differs: boolean): Chat => async () => JSON.stringify({ differs });

test('a drift flag is cleared when the yes/no check says the meaning is the same and every number in the sentence is in the source', async () => {
  const r = await verifyDrift(said(false), 'The module performs the five core steps.', entry, 'There are five core steps in the sensor pipeline.');
  assert.deepEqual(r, { cleared: true, numbers: ['5'], failures: [] });
});

test('a drift flag still blocks when the sentence has a number the source does not state, whatever the yes/no answer', async () => {
  const r = await verifyDrift(said(false), 'The module performs the seven core steps.', entry, 'There are five core steps in the sensor pipeline.');
  assert.equal(r.cleared, false);
});

const voting = (answers: Array<boolean | 'fail'>): Chat => { let i = 0; return async () => { const a = answers[i++]!; if (a === 'fail') throw new Error('down'); return JSON.stringify({ differs: a }); }; };

test('a drift flag is asked three times and stays only if at least two answers say the meaning differs', async () => {
  const claim = 'The module performs the five core steps.';
  const source = 'There are five core steps in the sensor pipeline.';
  assert.equal((await verifyDrift(voting([true, true, true]), claim, entry, source)).cleared, false);
  assert.equal((await verifyDrift(voting([true, true, false]), claim, entry, source)).cleared, false);
  assert.equal((await verifyDrift(voting([true, false, false]), claim, entry, source)).cleared, true, 'one dissenting answer does not hold a flag');
  assert.equal((await verifyDrift(voting([false, false, false]), claim, entry, source)).cleared, true);
  assert.equal((await verifyDrift(voting([false, true, false]), claim, entry, source)).cleared, true);
});

test('a drift check whose calls all fail leaves the flag standing, and a lone failure does not decide it', async () => {
  const claim = 'The module performs the five core steps.';
  const source = 'There are five core steps in the sensor pipeline.';
  const all = await verifyDrift(voting(['fail', 'fail', 'fail']), claim, entry, source);
  assert.equal(all.cleared, false);
  assert.ok(all.failures.length === 3);
  assert.equal((await verifyDrift(voting(['fail', false, false]), claim, entry, source)).cleared, true);
});

test('"cost" is a money keyword only near a price word or currency', () => {
  const k = (text: string) => gateReasons({ text, verdict: 'unsupported', category: null, quote: '' }).filter((r) => r.startsWith('keyword'));
  assert.deepEqual(k('Choose a partitioner that reduces the shuffle cost.'), []);
  assert.deepEqual(k('Each extra join adds a cost in latency.'), []);
  assert.deepEqual(k('The cost of the license is a fee per seat.'), ['keyword: it touches money']);
  assert.deepEqual(k('The cost stays under budget.'), ['keyword: it touches money']);
  assert.deepEqual(k('Compute costs several dollars an hour.'), ['keyword: it touches money']);
});
