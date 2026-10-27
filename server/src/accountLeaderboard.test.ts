// The leaderboard with accounts: synced badges count, old device-based entries can be claimed by an account and are then counted once.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';

const h = useHarness('acctlb');
const [A0, A1, A2] = [0, 1, 2].map((n) => () => h.articles[n]);
const verified = (article: string, minutes: number) => ({ article_id: article, verified_at: h.at(minutes), topic: 'Cloud' });
const named = (name: string) => ({ display_name: name, industry: 'Software', interests: ['Cloud'], updated_at: h.at(0) });
const board = async (token?: string, query = '') => (await h.call(token, 'GET', `/leaderboard${query}`)).json();
/** What an app from before accounts does: posts a verification under its random device number. */
const oldPost = (device: number, article: string, name = `Device ${device}`, minutes = -30) =>
  h.post(undefined, '/verifications', { device_id: h.device(device), display_name: name, article_id: article, verified_at: h.at(minutes) });

h.t('Scenario: A synced badge puts the account on the board under its profile name', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { profile: named('Alice A'), verified: [verified(A0(), -5), verified(A1(), -4)] });
  assert.deepEqual((await board()).rows, [{ rank: 1, display_name: 'Alice A', count: 2, is_you: false }]);
});

h.t('Scenario: No profile name yet - "Reader"', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { verified: [verified(A0(), -5)] });
  assert.equal((await board()).rows[0].display_name, 'Reader');
});

h.t('Scenario: Signed in, "you" is found by the session, with the true rank', async () => {
  const alice = (await h.signIn('alice')).token;
  const bob = (await h.signIn('bob')).token;
  await h.sync(alice, 0, { profile: named('Alice A'), verified: [verified(A0(), -9), verified(A1(), -8)] });
  await h.sync(bob, 0, { profile: named('Bob B'), verified: [verified(A0(), -7)] });
  const asBob = await board(bob);
  assert.deepEqual(asBob.rows.map((r: { display_name: string; is_you: boolean }) => [r.display_name, r.is_you]), [['Alice A', false], ['Bob B', true]]);
  assert.deepEqual(asBob.you, { rank: 2, display_name: 'Bob B', count: 1, is_you: true });
});

h.t('Scenario: Only name, count and rank leave the server - never industry, interests, email or the reading list', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { profile: { ...named('Alice A'), industry: 'Healthcare', interests: ['SecretTopic'] }, reading_list: [{ article_id: A2(), saved_at: h.at(0), removed: false, updated_at: h.at(0) }], verified: [verified(A0(), -5)] });
  const res = await h.call(token, 'GET', '/leaderboard');
  assert.deepEqual(Object.keys(res.json().rows[0]).sort(), ['count', 'display_name', 'is_you', 'rank']);
  for (const secret of ['Healthcare', 'SecretTopic', 'alice@example.com', A2()]) assert.ok(!res.body.includes(secret), secret);
});

h.t('Scenario: Claiming an old device - its badges join the account and are counted once, even where the account has the same article', async () => {
  await oldPost(1, A0(), 'Old Name');
  await oldPost(1, A1(), 'Old Name');
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { verified: [verified(A1(), -5), verified(A2(), -4)] });
  const claimed = await h.post(token, '/me/claim-device', { device_id: h.device(1) });
  assert.equal(claimed.statusCode, 200);
  assert.deepEqual(claimed.json(), { folded: 2 });
  const rows = (await board()).rows;
  assert.equal(rows.length, 1); // the old entry is not listed a second time
  assert.deepEqual(rows[0], { rank: 1, display_name: 'Old Name', count: 3, is_you: false }); // the account had no name, so the old one carries over
  const state = await h.pull(token);
  assert.deepEqual(state.verified.map((v: { article_id: string }) => v.article_id).sort(), [A0(), A1(), A2()].sort());
});

h.t('Scenario: Claiming twice is harmless', async () => {
  await oldPost(1, A0());
  const { token } = await h.signIn('alice');
  assert.deepEqual((await h.post(token, '/me/claim-device', { device_id: h.device(1) })).json(), { folded: 1 });
  assert.deepEqual((await h.post(token, '/me/claim-device', { device_id: h.device(1) })).json(), { folded: 0 });
  assert.equal((await board()).rows[0].count, 1);
});

h.t('Scenario: An older app keeps working - a verification it posts for a claimed device is credited to the account', async () => {
  await oldPost(1, A0());
  const { token } = await h.signIn('alice');
  await h.post(token, '/me/claim-device', { device_id: h.device(1) });
  assert.equal((await oldPost(1, A2())).statusCode, 204);
  assert.equal((await board()).rows.length, 1);
  assert.equal((await board()).rows[0].count, 2);
  assert.equal((await h.pull(token)).verified.length, 2);
});

h.t('Scenario: A second account cannot take a device that is already claimed - 409, and nothing changes for either', async () => {
  await oldPost(1, A0());
  const alice = (await h.signIn('alice')).token;
  const bob = (await h.signIn('bob')).token;
  await h.post(alice, '/me/claim-device', { device_id: h.device(1) });
  assert.equal((await h.post(bob, '/me/claim-device', { device_id: h.device(1) })).statusCode, 409);
  assert.equal((await h.pull(bob)).verified.length, 0);
  assert.equal((await h.pull(alice)).verified.length, 1);
});

h.t('Scenario: A device with nothing on the server can still be claimed (nothing folded), so its later posts are credited', async () => {
  const { token } = await h.signIn('alice');
  assert.deepEqual((await h.post(token, '/me/claim-device', { device_id: h.device(7) })).json(), { folded: 0 });
  await oldPost(7, A0());
  assert.equal((await h.pull(token)).verified.length, 1);
});

h.t('Scenario: Devices nobody has claimed are still on the board next to accounts', async () => {
  await oldPost(5, A0(), 'Legacy Lee');
  await oldPost(5, A1(), 'Legacy Lee');
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { profile: named('Alice A'), verified: [verified(A0(), -5)] });
  assert.deepEqual((await board()).rows.map((r: { display_name: string; count: number }) => [r.display_name, r.count]), [['Legacy Lee', 2], ['Alice A', 1]]);
});

h.t('Scenario: Bad claims - not signed in is 401, a device id that is not a UUID is 400', async () => {
  const { token } = await h.signIn('alice');
  assert.equal((await h.post(undefined, '/me/claim-device', { device_id: h.device(1) })).statusCode, 401);
  for (const body of [{}, { device_id: 'nope' }, { device_id: 5 }]) assert.equal((await h.post(token, '/me/claim-device', body)).statusCode, 400);
});
