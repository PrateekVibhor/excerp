// Sign in with Apple through the real API and the real SQL, in a throwaway schema. Apple is replaced by a fake verifier and a fake revoker (the real ones are tested in appleAuth.test.ts).
// Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REF, USERS, useHarness } from '../testkit/harness.ts';

const h = useHarness('apple');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const open = () => h.build({ allowAny: true });

h.t('Scenario: A first sign-in with Apple makes an account keyed by the Apple id only, and a session', async () => {
  const app = await open();
  const { res, body, ref } = await h.signInApple('ann', app);
  assert.equal(res.statusCode, 200);
  assert.equal(body.status, 'approved');
  assert.match(ref, REF);
  const accounts = await h.rows('SELECT google_sub, apple_sub, email, ref FROM accounts');
  assert.deepEqual(accounts.map((a) => ({ ...a })), [{ google_sub: null, apple_sub: 'apple-ann', email: 'ann@example.com', ref }]);
  const session = await h.call(body.session_token, 'GET', '/auth/session', undefined, app);
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().account_ref, ref);
});

h.t('Scenario: Signing in again is the same account, not a second one', async () => {
  const app = await open();
  const first = await h.signInApple('ann', app);
  const second = await h.signInApple('ann', app);
  assert.equal(second.ref, first.ref);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 1);
  assert.equal((await h.rows('SELECT 1 FROM sessions')).length, 2);
});

h.t("Scenario: A private-relay address works like any other verified address", async () => {
  const { body, ref } = await h.signInApple('relay', await open());
  assert.equal(body.status, 'approved');
  assert.deepEqual((await h.rows('SELECT email, apple_sub FROM accounts')).map((a) => ({ ...a })), [{ email: 'x7k2q@privaterelay.appleid.com', apple_sub: 'apple-relay' }]);
  assert.match(ref, REF);
});

h.t('Scenario: Where sign-in is by allow-list, an Apple address that is not on it is told "pending" and makes no account', async () => {
  const { body } = await h.signInApple('relay');
  assert.deepEqual(body, { status: 'pending' });
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
  assert.deepEqual((await h.rows('SELECT email FROM access_requests')).map((r) => r.email), ['x7k2q@privaterelay.appleid.com']);
});

h.t('Scenario: An email Apple has not verified is never approved', async () => {
  const { body } = await h.signInApple('unverifiedApple', await open());
  assert.deepEqual(body, { status: 'pending' });
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
});

h.t('Scenario: A Google account and an Apple account with the same real email stay two separate accounts, each with its own data', async () => {
  const google = await h.signIn('alice');
  const apple = await h.signInApple('aliceOnApple');
  assert.equal(apple.body.status, 'approved');
  assert.notEqual(apple.ref, google.ref);
  const accounts = await h.rows('SELECT google_sub, apple_sub, email FROM accounts ORDER BY created_at');
  assert.deepEqual(accounts.map((a) => ({ ...a })), [
    { google_sub: 'sub-alice', apple_sub: null, email: 'alice@example.com' },
    { google_sub: null, apple_sub: 'apple-alice', email: 'alice@example.com' },
  ]);
  // A profile saved on one is not seen on the other.
  await h.sync(google.token, 0, { profile: { display_name: 'Google Alice', industry: 'Software', interests: [], updated_at: h.at(-1) } });
  assert.equal((await h.pull(apple.token)).profile, null);
});

h.t('Scenario: A token that is not accepted is 401, a missing token or nonce is 400, Apple being unreachable is 503, and none of them makes an account', async () => {
  const forged = await h.signInApple('nobody' as never);
  assert.equal(forged.res.statusCode, 401);
  assert.deepEqual(forged.body, { error: 'invalid token' });
  assert.equal((await h.signInApple('ann', h.app, 'wrong-nonce')).res.statusCode, 401);
  assert.equal((await h.app.inject({ method: 'POST', url: '/auth/apple', payload: { identity_token: 'ann' } })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: '/auth/apple', payload: { nonce: 'good-nonce' } })).statusCode, 400);
  assert.equal((await h.signInApple('down')).res.statusCode, 503);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
});

h.t('Scenario: A banned Apple account is told "pending", the same as anyone not approved', async () => {
  const app = await open();
  await h.signInApple('ann', app);
  await h.pool.query("UPDATE accounts SET banned_at = now() WHERE apple_sub = 'apple-ann'");
  assert.deepEqual((await h.signInApple('ann', app)).body, { status: 'pending' });
});

// --- deleting an Apple account ---

h.t('Scenario: Deleting an Apple account with the code from signing in again revokes Apple access, writes the hash of the Apple id, and removes everything', async () => {
  const app = await open();
  const { token } = await h.signInApple('ann', app);
  const res = await h.post(token, '/auth/delete-account', { apple_authorization_code: 'code-1' }, app);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(h.revoked, ['code-1']);
  assert.deepEqual(h.revokedFor, ['apple-ann'], 'revoked for this account\'s Apple id');
  assert.deepEqual(h.deleted.map((d) => d.hash), [hash('apple-ann')]);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
  assert.equal((await h.rows('SELECT 1 FROM sessions')).length, 0);
  assert.equal((await h.call(token, 'GET', '/auth/session', undefined, app)).statusCode, 401);
  assert.deepEqual(h.logged, []);
});

h.t('Scenario: When Apple will not revoke, the account is still deleted and the failure is logged without the code or any id', async () => {
  const app = await open();
  const { token } = await h.signInApple('ann', app);
  h.revokeAnswer = 'failed';
  const res = await h.post(token, '/auth/delete-account', { apple_authorization_code: 'secret-code' }, app);
  assert.equal(res.statusCode, 204);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
  assert.deepEqual(h.logged, [{ event: 'apple_revoke_failed', reason: 'refused' }]);
  assert.doesNotMatch(JSON.stringify(h.logged), /secret-code|apple-ann|ann@/);
});

h.t('Scenario: With no code (an old app), the account is deleted, nothing is revoked, and that is logged', async () => {
  const app = await open();
  const { token } = await h.signInApple('ann', app);
  assert.equal((await h.post(token, '/auth/delete-account', undefined, app)).statusCode, 204);
  assert.deepEqual(h.revoked, []);
  assert.deepEqual(h.logged, [{ event: 'apple_revoke_failed', reason: 'no_code' }]);
  assert.equal((await h.rows('SELECT 1 FROM accounts')).length, 0);
});

h.t('Scenario: A Google account never triggers a revoke, even if a code is sent', async () => {
  const { token } = await h.signIn('alice');
  assert.equal((await h.post(token, '/auth/delete-account', { apple_authorization_code: 'code-x' })).statusCode, 204);
  assert.deepEqual(h.revoked, []);
  assert.deepEqual(h.logged, []);
  assert.deepEqual(h.deleted.map((d) => d.hash), [hash(USERS.alice.sub)]);
});

h.t('Scenario: Deleting an Apple account does not wipe a different account that shares the same real email: its sessions and its place on the allow-list stay', async () => {
  const google = await h.signIn('alice'); // alice@example.com is on the allow-list
  const apple = await h.signInApple('aliceOnApple');
  assert.equal((await h.post(apple.token, '/auth/delete-account', { apple_authorization_code: 'c' })).statusCode, 204);
  assert.equal((await h.rows('SELECT 1 FROM accounts WHERE apple_sub IS NOT NULL')).length, 0);
  assert.equal((await h.call(google.token, 'GET', '/auth/session')).statusCode, 200, 'the Google account is still signed in');
  assert.equal((await h.rows("SELECT 1 FROM allowed_emails WHERE email = 'alice@example.com'")).length, 1);
});

h.t('Scenario: The same guard the other way round: deleting the Google account leaves the Apple account signed in', async () => {
  const google = await h.signIn('alice');
  const apple = await h.signInApple('aliceOnApple');
  assert.equal((await h.post(google.token, '/auth/delete-account')).statusCode, 204);
  assert.equal((await h.call(apple.token, 'GET', '/auth/session')).statusCode, 200);
  assert.equal((await h.rows("SELECT 1 FROM allowed_emails WHERE email = 'alice@example.com'")).length, 1);
});

h.t('Scenario: With nobody else on the email, deleting still removes the email\'s allow-list place and waiting request as before', async () => {
  const { token } = await h.signIn('bob');
  assert.equal((await h.post(token, '/auth/delete-account')).statusCode, 204);
  assert.equal((await h.rows("SELECT 1 FROM allowed_emails WHERE email = 'bob@example.com'")).length, 0);
});
