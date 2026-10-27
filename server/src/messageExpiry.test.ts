// Things end: an unanswered request after 30 days, every message after 12 months, an abandoned or resolved record after its time.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';
import { purgeExpired } from './messageExpiry.ts';

const h = useHarness('expiry');
const send = (token: string, body: unknown) => h.post(token, '/me/messages', body);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();

async function requested() {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  await send(alice.token, { to: await h.publicId('bob'), subject: 'Hi', body: 'A note for you.' });
  return { alice, bob, id: (await inbox(bob.token)).requests[0].id as string };
}

h.t('Scenario: A request nobody answers for 30 days expires - it cannot be accepted, and the sender sees "expired"', async () => {
  const { alice, bob, id } = await requested();
  await h.advance(29);
  assert.equal((await purgeExpired(h.pool, h.clock.now)).expiredRequests, 0);
  assert.equal((await inbox(bob.token)).requests.length, 1); // still there on day 29
  await h.advance(2); // day 31
  const result = await purgeExpired(h.pool, h.clock.now);
  assert.equal(result.expiredRequests, 1);
  assert.equal((await inbox(bob.token)).requests.length, 0);
  const sent = (await inbox(alice.token)).sent;
  assert.equal(sent[0].state, 'expired');
  const late = await h.post(bob.token, `/me/conversations/${id}/accept`);
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'expired');
});

h.t('Scenario: A request that is past 30 days cannot be accepted even before the cleanup has run', async () => {
  const { bob, id } = await requested();
  await h.advance(31);
  const late = await h.post(bob.token, `/me/conversations/${id}/accept`);
  assert.equal(late.statusCode, 409);
  assert.equal((await inbox(bob.token)).requests.length, 0);
});

h.t('Scenario: A declined request looks the same to the sender as one that is still waiting, and as one that has expired', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/decline`);
  assert.equal((await inbox(alice.token)).sent[0].state, 'pending');
  await h.advance(31);
  await purgeExpired(h.pool, h.clock.now);
  assert.equal((await inbox(alice.token)).sent[0].state, 'expired');
});

h.t('Scenario: An accepted conversation does not expire after 30 days', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/accept`);
  await h.advance(60);
  assert.equal((await purgeExpired(h.pool, h.clock.now)).expiredRequests, 0);
  assert.equal((await inbox(alice.token)).conversations.length, 1);
});

h.t('Scenario: Every message goes after 12 months, and with the last one the conversation', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/accept`);
  await send(bob.token, { conversation_id: id, body: 'Sent later' });
  await h.advance(364);
  assert.deepEqual((({ deletedMessages, deletedConversations }) => ({ deletedMessages, deletedConversations }))(await purgeExpired(h.pool, h.clock.now)), { deletedMessages: 0, deletedConversations: 0 });
  assert.equal((await inbox(alice.token)).conversations.length, 1);
  await h.advance(2); // 366 days after both messages
  const result = await purgeExpired(h.pool, h.clock.now);
  assert.deepEqual({ deletedMessages: result.deletedMessages, deletedConversations: result.deletedConversations }, { deletedMessages: 2, deletedConversations: 1 });
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 0);
  assert.equal((await h.rows('SELECT 1 FROM conversations')).length, 0);
});

h.t('Scenario: A message past 12 months is already out of sight before the cleanup runs', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/accept`);
  await h.advance(366);
  const mine = await inbox(alice.token);
  assert.deepEqual([mine.conversations.length, mine.sent.length, mine.unread], [0, 0, 0]);
  assert.equal((await h.call(alice.token, 'GET', `/me/conversations/${id}`)).statusCode, 404);
});

h.t('Scenario: When the old conversation is gone the two may write to each other again', async () => {
  const { alice, bob } = await requested();
  assert.equal((await send(alice.token, { to: await h.publicId('bob'), body: 'Again' })).statusCode, 409);
  await h.advance(366);
  await purgeExpired(h.pool, h.clock.now);
  assert.equal((await send(alice.token, { to: await h.publicId('bob'), body: 'A fresh start' })).statusCode, 204);
  void bob;
});

h.t('Scenario: A resolved report is kept 90 days then removed; an open one is kept; the cleanup can be run again', async () => {
  const alice = await h.member('alice');
  await h.member('bob');
  await h.member('carol');
  await h.post(alice.token, '/me/reports', { public_id: await h.publicId('bob'), reason: 'spam' });
  await h.post(alice.token, '/me/reports', { public_id: await h.publicId('carol'), reason: 'spam' });
  await h.rows(`UPDATE reports SET status = 'resolved', handled_at = $1 WHERE reported_id = (SELECT id FROM accounts WHERE email = 'bob@example.com')`, [h.clock.now]);
  await h.advance(89);
  assert.equal((await purgeExpired(h.pool, h.clock.now)).deletedReports, 0);
  await h.advance(2);
  assert.equal((await purgeExpired(h.pool, h.clock.now)).deletedReports, 1);
  assert.equal((await h.rows('SELECT status FROM reports')).length, 1);
  assert.equal((await h.rows('SELECT status FROM reports'))[0].status, 'open');
  assert.deepEqual(await purgeExpired(h.pool, h.clock.now), { expiredRequests: 0, deletedMessages: 0, deletedConversations: 0, deletedReports: 0 });
});
