// Accounts: one per Google `sub`, made at an approved sign-in, with a short reference code the app can show.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accountRef } from './accounts.ts';
import { REF, useHarness } from '../testkit/harness.ts';

const h = useHarness('acct');

h.t('Scenario: Approved sign-in - an account is made for the Google sub, and the answer carries its reference code', async () => {
  const { res, body, ref } = await h.signIn('alice');
  assert.equal(res.statusCode, 200);
  assert.equal(body.status, 'approved');
  assert.match(ref, REF);
  const accounts = await h.rows('SELECT google_sub, email, ref, sync_started_at FROM accounts');
  assert.equal(accounts.length, 1);
  assert.deepEqual({ ...accounts[0] }, { google_sub: 'sub-alice', email: 'alice@example.com', ref, sync_started_at: null });
});

h.t('Scenario: Signing in again - the same account, not a second one', async () => {
  const first = await h.signIn('alice');
  const second = await h.signIn('alice');
  assert.equal(second.ref, first.ref);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 1);
});

h.t('Scenario: The Google account changes its email - the account stays, with the new email', async () => {
  const before = await h.signIn('alice');
  const after = await h.signIn('alice2');
  assert.equal(after.ref, before.ref);
  const accounts = await h.rows('SELECT email FROM accounts');
  assert.deepEqual(accounts.map((a) => a.email), ['alice.new@example.com']);
});

h.t('Scenario: Each session belongs to the account', async () => {
  await h.signIn('alice');
  await h.signIn('alice');
  const [account] = await h.rows('SELECT id FROM accounts');
  const sessions = await h.rows('SELECT account_id FROM sessions');
  assert.equal(sessions.length, 2);
  for (const s of sessions) assert.equal(s.account_id, account.id);
});

h.t('Scenario: Not on the list - no account is made, and nothing about the reader is kept beyond the waiting request', async () => {
  const { body } = await h.signIn('stranger');
  assert.deepEqual(body, { status: 'pending' });
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
});

h.t('Scenario: Google email not verified - no account', async () => {
  await h.signIn('unverified');
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
});

h.t('Scenario: GET /auth/session gives the same reference code', async () => {
  const { token, ref } = await h.signIn('alice');
  const res = await h.call(token, 'GET', '/auth/session');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().account_ref, ref);
});

h.t('Scenario: The reference code - derived from the sub the same way every time, different for different people, and not containing the sub', async () => {
  const ref = accountRef('sub-alice');
  assert.match(ref, REF);
  assert.equal(accountRef('sub-alice'), ref);
  assert.notEqual(accountRef('sub-bob'), ref);
  assert.ok(!ref.toLowerCase().includes('alice'));
  // It is the first 40 bits of SHA-256(sub) in Crockford base32, so it cannot be turned back into the sub.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bits = [...createHash('sha256').update('sub-alice').digest().subarray(0, 5)].map((b) => b.toString(2).padStart(8, '0')).join('');
  const code = (bits.match(/.{5}/g) ?? []).map((g) => alphabet[parseInt(g, 2)]).join('');
  assert.equal(ref, `EXC-${code.slice(0, 4)}-${code.slice(4)}`);
});
