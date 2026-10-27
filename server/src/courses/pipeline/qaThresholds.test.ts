import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, gateReasons, type CheckedClaim } from './accuracy.ts';

const claim = (text: string, verdict: CheckedClaim['verdict'] = 'supported', category: CheckedClaim['category'] = null, extra: Partial<CheckedClaim> = {}): CheckedClaim => ({ text, verdict, category, quote: '', ...extra });
const supported = (n: number) => Array.from({ length: n }, (_, i) => claim(`fine claim ${i}`));
const prose = (text = 'Good architecture helps a service stay fast.') => claim(text, 'unsupported');

test('prose-only flags never block and never send the chapter back for a rewrite, however many there are', () => {
  for (const round of ['first', 'afterRewrite'] as const) {
    assert.equal(decide([...supported(3), prose('Sam keeps the design simple.'), prose('Teams share goals.'), prose('Fault tolerance spreads the load.')], round).action, 'pass');
  }
  assert.equal(decide([], 'afterRewrite').action, 'pass');
});

test('a flag blocks when it holds a number or a percentage, or the agent gave it a law, safety, money or health label', () => {
  assert.deepEqual(gateReasons(prose('The standup lasts 15 minutes.')).map((r) => r.split(':')[0]), ['number']);
  assert.equal(gateReasons(prose('Most teams see a big gain from it.')).length, 0);
  assert.ok(gateReasons(prose('Adoption rose by 40 percent.')).length > 0);
  for (const category of ['law', 'safety', 'money', 'health'] as const) assert.ok(gateReasons(claim('A rule.', 'unsupported', category)).length > 0, category);
});

test('a flag blocks when its text hits a law, safety, money, health or security keyword', () => {
  for (const text of ['Employers must follow the labour law.', 'This avoids a safety hazard.', 'A higher salary follows.', 'It protects patient health.', 'Always encrypt data stored in public cloud buckets.', 'Add authentication to each endpoint.'])
    assert.ok(gateReasons(prose(text)).length > 0, text);
  assert.equal(gateReasons(prose('Sam sketches the endpoints first.')).length, 0);
});

test('a contradicted flag (a quoted source passage that really conflicts) blocks', () => {
  assert.ok(gateReasons(claim('Sam does a thing.', 'contradicted', null, { quote: 'a real passage' })).length > 0);
});

test('first pass: a gated flag sends the chapter back for one rewrite, with only the gated claims named; after it, a gated flag fails the run with reasons', () => {
  const claims = [...supported(5), prose(), claim('The standup lasts 15 minutes.', 'unsupported')];
  const first = decide(claims, 'first');
  assert.equal(first.action, 'rewrite');
  assert.deepEqual(first.action === 'rewrite' && first.flagged.map((c) => c.text), ['The standup lasts 15 minutes.']);
  const after = decide(claims, 'afterRewrite');
  assert.equal(after.action, 'fail');
  assert.match(after.action === 'fail' ? after.reasons.join() : '', /number/i);
});

test('a definition conflict does not block: it passes and is handed back for the owner to review', () => {
  const def = claim('The F1 score is the mean of precision and recall.', 'unsupported', null, { definitionConflict: true });
  const d = decide([...supported(5), def], 'afterRewrite');
  assert.equal(d.action, 'pass');
  assert.deepEqual(d.action === 'pass' && d.review?.map((c) => c.text), [def.text]);
  assert.equal(decide([...supported(5), def], 'first').action, 'pass');
});

test('a digit inside a name such as F1 or S3 is not a number', () => {
  assert.equal(gateReasons(prose('The F1 score balances precision and recall.')).length, 0);
});

test('a number word inside a capitalised name (Three Amigos) is not a number; one in plain text still is', () => {
  assert.equal(gateReasons(prose('Sam joins Three Amigos sessions with a tester.')).length, 0);
  assert.equal(gateReasons(prose('Sam joins the Three Amigos sessions.')).length, 0);
  assert.ok(gateReasons(prose('Three teams share the load.')).length > 0);
  assert.ok(gateReasons(prose('The standup lasts fifteen minutes.')).length > 0);
});

test('a digit after a capitalised acronym (PEP 8, ISO 27001) is a name, not a number', () => {
  assert.equal(gateReasons(prose('Sam follows PEP 8 when commenting complex logic.')).length, 0);
  assert.ok(gateReasons(prose('Sam waits 8 minutes before commenting complex logic.')).length > 0);
});

test('"health" after system, service, cluster, app or application is not a health claim; medical health still is', () => {
  for (const text of ['Metrics give quantitative system health signals.', 'The cluster health is shown on the dashboard.', 'Checks report application health and service health.'])
    assert.equal(gateReasons(prose(text)).length, 0, text);
  assert.ok(gateReasons(prose('Burnout harms mental health.')).length > 0);
  assert.ok(gateReasons(prose('The health of the patient improves.')).length > 0);
});

test('a digit joined to a capitalised technique name (5-Whys, 5 Whys) is a name, not a number; a digit with a unit still is', () => {
  for (const text of ['Using the 5-Whys technique, Sam traces the stall to a missing data field.', 'Using the 5‑Whys technique, Sam traces the stall.', 'Sam applies the 5 Whys to the stalled loan.'])
    assert.equal(gateReasons(prose(text)).length, 0, text);
  assert.ok(gateReasons(prose('Sam asks why 5 times about the stall.')).length > 0);
  assert.ok(gateReasons(prose('Sam repeats the 5-minute check.')).length > 0);
});

test('"contract" is a law keyword only near legal words; an API, interface or type contract is not a legal one', () => {
  for (const text of ['Sam shows a function signature that makes the contract visible to everyone.', 'To make the contracts explicit, Sam chose TypeScript so the service interfaces read as code.', 'The API contract between the services is versioned.', 'A type contract tells callers what shape of data to send.'])
    assert.equal(gateReasons(prose(text)).length, 0, text);
  for (const text of ['The employment contract sets the notice period and liability terms.', 'Sam signs the contract with the vendor after legal review.', 'The contract clause on termination was disputed in court.', 'Both parties to the contract must agree to the change.'])
    assert.ok(gateReasons(prose(text)).some((r) => r.includes('law')), text);
});

test('technical uses of "safety" (safety net, type safety, memory safety, thread safety) are not the safety keyword; workplace and physical safety still are', () => {
  for (const text of ['Sam describes the type system as a safety net that catches mistakes early.', 'Type safety rules out a whole class of bugs.', 'Memory safety and thread safety matter in systems code.'])
    assert.equal(gateReasons(prose(text)).length, 0, text);
  for (const text of ['Workers must wear helmets as a workplace safety rule.', 'The safety inspection found a fire hazard in the warehouse.', 'Sam completes the safety training before using the machine.'])
    assert.ok(gateReasons(prose(text)).some((r) => r.includes('safety')), text);
});

test('a gated word that is part of a concept the chapter teaches does not block the sentence by the keyword alone', () => {
  const taught = ['regulatory compliance', 'pricing strategy', 'fraud prevention'];
  for (const text of ['Alex learns regulatory compliance by shadowing the product owner.', 'Alex builds a pricing strategy for the new tier with the team.', 'Alex studies fraud prevention and risk management on the payments squad.'])
    assert.equal(gateReasons(prose(text), taught).length, 0, text);
  assert.ok(gateReasons(prose('Alex learns regulatory compliance by shadowing the product owner.')).length > 0, 'without the taught concept it still blocks');
  assert.equal(gateReasons(prose('Alex builds a pricing strategy for the new tier.'), ['business acumen']).length > 0, true, 'a concept that is not in the sentence exempts nothing');
});

test('the concept-name exemption never hides a figure, a stated rule, the agent\'s label or a contradiction', () => {
  const taught = ['regulatory compliance', 'pricing strategy'];
  assert.ok(gateReasons(prose('Pricing strategy raised revenue by 20 percent.'), taught).length > 0, 'a percentage');
  assert.ok(gateReasons(prose('Pricing strategy sets the plan at $5 per seat.'), taught).length > 0, 'a dollar figure');
  assert.ok(gateReasons(prose('The law requires companies to report within 30 days.'), taught).length > 0, 'a legal requirement with a figure');
  assert.ok(gateReasons(prose('Regulatory compliance means the law is followed.'), taught).some((r) => r.includes('law')), 'a stated rule outside the concept name');
  assert.ok(gateReasons({ text: 'Alex learns regulatory compliance by shadowing the product owner.', verdict: 'unsupported', category: 'law', quote: '' }, taught).some((r) => r.startsWith('category')), "the agent's label");
  assert.ok(gateReasons({ text: 'Alex learns regulatory compliance by shadowing the product owner.', verdict: 'contradicted', category: null, quote: 'q' }, taught).some((r) => r.startsWith('contradicted')), 'a contradiction');
});

test('decide uses the taught concepts too: a chapter whose only flag names its concept passes', () => {
  const flag = { text: 'Alex learns regulatory compliance by shadowing the product owner.', verdict: 'unsupported' as const, category: null, quote: '' };
  assert.equal(decide([flag], 'first', ['regulatory compliance']).action, 'pass');
  assert.equal(decide([flag], 'first').action, 'rewrite');
});
