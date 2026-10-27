// Plan 16, phase 2, step 6: the single list of tracked companies that discovery searches (spec decision 29). It holds links and
// counts only. A company is trusted after repeated successes, blocked after repeated failures or at once if a site disallows fetching,
// and the owner can edit any of it.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { BLOCK_AFTER_FAILURES, createTrackedCompanies, TRUST_AFTER_SUCCESSES } from './trackedCompanies.ts';

const { db } = useCourseDb('tracked', { reset: ['tracked_companies'] });
const T = new Date('2026-10-20T09:00:00.000Z');
const row = async (p: import('pg').Pool, domain: string) => (await p.query(`SELECT * FROM tracked_companies WHERE domain = $1`, [domain])).rows[0];

db('a company is added as a candidate with its domain in lower case, once', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  const added = await list.add({ employer: 'Acme', domain: 'Jobs.Acme.com', careersUrl: 'https://jobs.acme.com', addedBy: 'search' });
  assert.equal(added, true);
  const r = await row(p, 'jobs.acme.com');
  assert.deepEqual([r.employer, r.status, r.added_by, r.successes, r.failures], ['Acme', 'candidate', 'search', 0, 0]);
  assert.equal(await list.add({ employer: 'Acme again', domain: 'jobs.acme.com', addedBy: 'search' }), false, 'a second add changes nothing');
  assert.equal((await row(p, 'jobs.acme.com')).employer, 'Acme');
});

db('Scenario: a candidate becomes trusted after repeated successes, not before', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  await list.add({ employer: 'Acme', domain: 'acme.example.com', addedBy: 'seed' });
  for (let i = 1; i < TRUST_AFTER_SUCCESSES; i++) {
    await list.recordOutcome('acme.example.com', true);
    assert.equal((await row(p, 'acme.example.com')).status, 'candidate', `after ${i}`);
  }
  await list.recordOutcome('acme.example.com', true);
  const r = await row(p, 'acme.example.com');
  assert.deepEqual([r.status, r.successes], ['trusted', TRUST_AFTER_SUCCESSES]);
  assert.equal(r.last_checked_at.toISOString(), T.toISOString());
});

db('Scenario: a company is blocked after repeated failures, but a trusted one with a good record is not', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  await list.add({ employer: 'Bad', domain: 'bad.example.com', addedBy: 'search' });
  for (let i = 0; i < BLOCK_AFTER_FAILURES; i++) await list.recordOutcome('bad.example.com', false);
  assert.equal((await row(p, 'bad.example.com')).status, 'blocked');

  await list.add({ employer: 'Good', domain: 'good.example.com', addedBy: 'seed' });
  for (let i = 0; i < 10; i++) await list.recordOutcome('good.example.com', true);
  for (let i = 0; i < BLOCK_AFTER_FAILURES; i++) await list.recordOutcome('good.example.com', false);
  const good = await row(p, 'good.example.com');
  assert.deepEqual([good.status, good.successes, good.failures], ['trusted', 10, BLOCK_AFTER_FAILURES], 'failures do not outweigh a record of successes');
});

db('Scenario: a site that disallows fetching is blocked at once, and a blocked company is never searched', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  await list.add({ employer: 'Rude', domain: 'rude.example.com', addedBy: 'search' });
  await list.add({ employer: 'Fine', domain: 'fine.example.com', addedBy: 'seed' });
  await list.blockForRobots('rude.example.com');
  assert.equal((await row(p, 'rude.example.com')).status, 'blocked');
  assert.deepEqual(await list.searchDomains(), ['fine.example.com']);
  await list.recordOutcome('rude.example.com', true); // a success does not unblock it
  assert.equal((await row(p, 'rude.example.com')).status, 'blocked');
});

db('the search list holds trusted and candidate companies, and a match is recorded', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  for (const [d, status] of [['a.example.com', 'trusted'], ['b.example.com', 'candidate'], ['c.example.com', 'blocked']] as const) {
    await list.add({ employer: d, domain: d, addedBy: 'seed' });
    await list.setStatus(d, status);
  }
  assert.deepEqual((await list.searchDomains()).sort(), ['a.example.com', 'b.example.com']);
  await list.recordMatch('a.example.com');
  assert.equal((await row(p, 'a.example.com')).last_matched_at.toISOString(), T.toISOString());
});

db('the owner can edit the list: set a status, change the careers link, and unblock a company', async (p) => {
  const list = createTrackedCompanies(p, () => T);
  await list.add({ employer: 'Acme', domain: 'acme.example.com', addedBy: 'search' });
  for (let i = 0; i < BLOCK_AFTER_FAILURES; i++) await list.recordOutcome('acme.example.com', false);
  assert.equal((await row(p, 'acme.example.com')).status, 'blocked');
  await list.setStatus('acme.example.com', 'candidate'); // unblocking starts the record again
  const r = await row(p, 'acme.example.com');
  assert.deepEqual([r.status, r.successes, r.failures], ['candidate', 0, 0]);
  await list.setCareersUrl('acme.example.com', 'https://acme.example.com/careers');
  assert.equal((await row(p, 'acme.example.com')).careers_url, 'https://acme.example.com/careers');
  assert.equal(await list.setStatus('nobody.example.com', 'trusted'), false);
  await assert.rejects(list.setStatus('acme.example.com', 'great' as never));
});

db('the table holds links and counts only: no column can hold page text', async (p) => {
  const { rows } = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tracked_companies' ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.column_name), ['added_by', 'careers_url', 'created_at', 'domain', 'employer', 'failures', 'id', 'last_checked_at', 'last_matched_at', 'status', 'successes']);
});
