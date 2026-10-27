// Deleting an account: what you sent stays with the people you sent it to, without your name; what only you could see goes with you.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';
import { purgeExpired } from './messageExpiry.ts';

const h = useHarness('msgdel');
const send = (token: string, body: unknown) => h.post(token, '/me/messages', body);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();
const del = (token: string) => h.post(token, '/auth/delete-account');

async function requested() {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  await send(alice.token, { to: await h.publicId('bob'), subject: 'A pitch', body: 'Something worth keeping for 12 months.' });
  return { alice, bob, id: (await inbox(bob.token)).requests[0].id as string };
}

h.t('Scenario: A sender deletes their account - the recipient still has the message, from "Deleted account", with nothing linking it to the person', async () => {
  const { alice, bob, id } = await requested();
  assert.equal((await del(alice.token)).statusCode, 204);
  const mine = await inbox(bob.token);
  assert.equal(mine.requests.length, 1);
  const [request] = mine.requests;
  assert.deepEqual(request.other, { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true });
  assert.equal(request.last_message.body, 'Something worth keeping for 12 months.');
  assert.equal(request.last_message.subject, 'A pitch');
  assert.equal(request.last_message.from, 'them');
  const [row] = await h.rows('SELECT sender_id FROM messages');
  assert.equal(row.sender_id, null);
  assert.ok(!JSON.stringify(mine).includes('alice')); // not the name, not anything
  assert.equal((await h.rows(`SELECT 1 FROM accounts WHERE email = 'alice@example.com'`)).length, 0);
});

h.t('Scenario: The recipient can still accept it, but cannot write back to a deleted account', async () => {
  const { alice, bob, id } = await requested();
  await del(alice.token);
  assert.equal((await h.post(bob.token, `/me/conversations/${id}/accept`)).statusCode, 204);
  const reply = await send(bob.token, { conversation_id: id, body: 'Anyone there?' });
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.json().error, 'deleted account');
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 1);
});

h.t('Scenario: A sender in an open conversation deletes - what they wrote stays, what they received is theirs to lose', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/accept`);
  await send(bob.token, { conversation_id: id, body: 'Thanks for writing' });
  await send(alice.token, { conversation_id: id, body: 'My follow-up' });
  await del(alice.token);
  const thread = (await h.call(bob.token, 'GET', `/me/conversations/${id}`)).json();
  assert.deepEqual(thread.messages.map((m: { from: string; body: string }) => [m.from, m.body]), [['them', 'Something worth keeping for 12 months.'], ['me', 'Thanks for writing'], ['them', 'My follow-up']]);
  assert.equal(thread.other.deleted, true);
});

h.t('Scenario: A recipient deletes - the sender keeps their own sent message, and sees the other side as "Deleted account"', async () => {
  const { alice, bob, id } = await requested();
  await del(bob.token);
  const sent = (await inbox(alice.token)).sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].other.deleted, true);
  assert.equal(sent[0].other.display_name, 'Deleted account');
  assert.equal(sent[0].last_message.body, 'Something worth keeping for 12 months.');
  assert.equal(sent[0].state, 'pending');
  void id;
});

h.t('Scenario: When both are gone nothing is left of the conversation', async () => {
  const { alice, bob } = await requested();
  await del(alice.token);
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 1);
  await del(bob.token);
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 0);
  assert.equal((await h.rows('SELECT 1 FROM conversations')).length, 0);
});

h.t('Scenario: A deleted sender\'s message still expires at 12 months', async () => {
  const { alice, bob } = await requested();
  await del(alice.token);
  await h.advance(366);
  assert.deepEqual([(await inbox(bob.token)).requests.length], [0]);
  assert.equal((await purgeExpired(h.pool, h.clock.now)).deletedMessages, 1);
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 0);
});

h.t('Scenario: What the person themselves had - blocks, hidden marks - goes with them, and nothing in the conversation points at them', async () => {
  const { alice, bob, id } = await requested();
  await h.post(bob.token, `/me/conversations/${id}/accept`);
  await h.post(bob.token, '/me/blocks', { public_id: await h.publicId('alice') });
  await del(bob.token);
  assert.equal((await h.rows('SELECT 1 FROM blocks')).length, 0);
  const [c] = await h.rows('SELECT initiator_id, recipient_id FROM conversations');
  assert.equal(c.recipient_id, null);
  assert.equal((await h.rows('SELECT recipient_id FROM messages'))[0].recipient_id, null);
  void alice;
});
