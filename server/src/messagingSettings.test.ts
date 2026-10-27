// GET/PUT /me/messaging-settings: who may be seen by other readers and who may be messaged, behind an 18+ and Terms confirmation.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';

const h = useHarness('msgset');
const OFF = { discoverable: false, accepts_messages: false, adult_confirmed: false, terms_accepted: false };
const CONFIRM = { confirm_adult: true, accept_terms: true };
const named = (token: string, name = 'Alice A') => h.sync(token, 0, { profile: { display_name: name, industry: 'Software', interests: ['Cloud'], updated_at: h.at(-1) } });
const get = async (token: string) => (await h.call(token, 'GET', '/me/messaging-settings')).json();

h.t('Scenario: Everything is off to begin with, and nothing has been confirmed', async () => {
  const { token } = await h.signIn('alice');
  const res = await h.call(token, 'GET', '/me/messaging-settings');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), OFF);
  assert.equal(res.headers['cache-control'], 'no-store');
});

h.t('Scenario: Not signed in - 401, and a session from before accounts is told to sign in again', async () => {
  assert.equal((await h.call(undefined, 'GET', '/me/messaging-settings')).statusCode, 401);
  assert.equal((await h.settings('made-up', { discoverable: true })).statusCode, 401);
  const old = await h.auth().createSession('alice@example.com', h.clock.now); // no account
  assert.equal((await h.settings(old.token, { discoverable: false })).statusCode, 401);
});

h.t('Scenario: Turning visibility on needs the reader to confirm they are 18 or older and accept the Terms - once', async () => {
  const { token } = await h.signIn('alice');
  await named(token);
  const refused = await h.settings(token, { discoverable: true });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, 'confirmation required');
  assert.deepEqual(await get(token), OFF);
  const ok = await h.settings(token, { discoverable: true, ...CONFIRM });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { discoverable: true, accepts_messages: false, adult_confirmed: true, terms_accepted: true });
  assert.equal((await h.rows('SELECT adult_confirmed_at, terms_accepted_at FROM accounts'))[0].adult_confirmed_at.getTime(), h.clock.now.getTime());
  // Off and on again: no second confirmation.
  await h.settings(token, { discoverable: false });
  assert.equal((await h.settings(token, { discoverable: true })).statusCode, 200);
});

h.t('Scenario: Both confirmations are needed, and only a plain true counts', async () => {
  const { token } = await h.signIn('alice');
  await named(token);
  for (const body of [
    { discoverable: true, confirm_adult: true },
    { discoverable: true, accept_terms: true },
    { discoverable: true, confirm_adult: false, accept_terms: true },
    { discoverable: true, confirm_adult: 'yes', accept_terms: 'yes' },
    { discoverable: true, confirm_adult: 1, accept_terms: 1 },
  ]) assert.equal((await h.settings(token, body)).statusCode, 400, JSON.stringify(body));
  assert.deepEqual(await get(token), OFF);
});

h.t('Scenario: A reader with no saved profile name cannot be shown to others, and a refused request records nothing', async () => {
  const { token } = await h.signIn('alice'); // no profile synced
  const res = await h.settings(token, { discoverable: true, ...CONFIRM });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'profile required');
  assert.deepEqual(await get(token), OFF); // the confirmations were not recorded either
  const [row] = await h.rows('SELECT adult_confirmed_at, terms_accepted_at FROM accounts');
  assert.equal(row.adult_confirmed_at, null);
  assert.equal(row.terms_accepted_at, null);
});

h.t('Scenario: Receiving messages needs visibility, and hiding yourself stops messages too', async () => {
  const { token } = await h.signIn('alice');
  await named(token);
  assert.equal((await h.settings(token, { accepts_messages: true, ...CONFIRM })).statusCode, 400); // not visible
  const both = await h.settings(token, { discoverable: true, accepts_messages: true, ...CONFIRM });
  assert.deepEqual(both.json(), { discoverable: true, accepts_messages: true, adult_confirmed: true, terms_accepted: true });
  const hidden = await h.settings(token, { discoverable: false });
  assert.equal(hidden.statusCode, 200);
  assert.deepEqual(hidden.json(), { discoverable: false, accepts_messages: false, adult_confirmed: true, terms_accepted: true });
  // Messages can be turned off on their own and the reader stays visible.
  await h.settings(token, { discoverable: true, accepts_messages: true });
  assert.deepEqual((await h.settings(token, { accepts_messages: false })).json().discoverable, true);
});

h.t('Scenario: Turning things off is always allowed, with no profile and no confirmation', async () => {
  const { token } = await h.signIn('alice');
  assert.equal((await h.settings(token, { discoverable: false, accepts_messages: false })).statusCode, 200);
});

h.t('Scenario: Bad input - 400, and nothing changes', async () => {
  const { token } = await h.signIn('alice');
  await named(token);
  await h.settings(token, { discoverable: true, ...CONFIRM });
  for (const body of [{ discoverable: 'yes' }, { discoverable: 1 }, { accepts_messages: null }, [], 'on', null]) {
    const status = (await h.settings(token, body)).statusCode;
    assert.ok(status === 400 || status === 415, `${JSON.stringify(body)} -> ${status}`); // plain text is "unsupported media type", as on every route
  }
  assert.equal((await get(token)).discoverable, true);
  assert.equal((await h.settings(token, {})).statusCode, 200); // asking for no change is fine
  assert.equal((await h.settings(token, { unknown: true })).statusCode, 200); // extra fields are ignored
});

h.t('Scenario: A suspended account cannot turn anything on, but can always turn things off', async () => {
  const { token } = await h.signIn('alice');
  await named(token);
  await h.settings(token, { discoverable: true, ...CONFIRM });
  await h.rows(`UPDATE accounts SET suspended_until = $1`, [new Date(h.clock.now.getTime() + 86_400_000)]);
  await h.settings(token, { discoverable: false });
  const res = await h.settings(token, { discoverable: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'suspended');
  await h.rows(`UPDATE accounts SET suspended_until = $1`, [new Date(h.clock.now.getTime() - 1000)]); // over
  assert.equal((await h.settings(token, { discoverable: true })).statusCode, 200);
});

h.t('Scenario: The choices belong to the account - kept across sign-in, separate for each reader', async () => {
  const alice = (await h.signIn('alice')).token;
  const bob = (await h.signIn('bob')).token;
  await named(alice);
  await h.settings(alice, { discoverable: true, ...CONFIRM });
  assert.equal((await get(bob)).discoverable, false);
  const again = (await h.signIn('alice')).token; // another phone
  assert.equal((await get(again)).discoverable, true);
});

h.t('Scenario: A new account starts with a random public id that is not any other id of theirs', async () => {
  await h.signIn('alice');
  const [a] = await h.rows('SELECT id, public_id, ref FROM accounts');
  assert.match(a.public_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.public_id, a.id);
});
