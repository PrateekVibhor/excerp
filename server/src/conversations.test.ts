// What happens after a request: accepting, declining without a word, replying, reading, hiding, blocking, and polling for news.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../testkit/harness.ts';

const h = useHarness('convs');
const send = (token: string | undefined, body: unknown, app = h.app) => h.post(token, '/me/messages', body, app);
const pitch = async (token: string, to: UserKey, extra: Record<string, unknown> = {}, app = h.app) =>
  send(token, { to: await h.publicId(to), subject: 'Hello', body: 'I would like to talk about your take.', ...extra }, app);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();
const changes = async (token: string, since: number) => (await h.call(token, 'GET', `/me/inbox/changes?since=${since}`)).json();
const thread = (token: string | undefined, id: string) => h.call(token, 'GET', `/me/conversations/${id}`);
const accept = (token: string | undefined, id: string) => h.post(token, `/me/conversations/${id}/accept`);
const decline = (token: string | undefined, id: string) => h.post(token, `/me/conversations/${id}/decline`);
const read = (token: string | undefined, id: string) => h.post(token, `/me/messages/${id}/read`);
const hide = (token: string | undefined, id: string) => h.call(token, 'DELETE', `/me/messages/${id}`);

/** Alice sends a request to Bob; returns both, and the conversation id. */
async function requested() {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  assert.equal((await pitch(alice.token, 'bob')).statusCode, 204);
  const id = (await inbox(bob.token)).requests[0].id as string;
  return { alice, bob, id };
}
async function opened() {
  const t = await requested();
  assert.equal((await accept(t.bob.token, t.id)).statusCode, 204);
  return t;
}

h.t('Scenario: Accepting opens a real conversation, where either side can write', async () => {
  const { alice, bob, id } = await requested();
  const res = await accept(bob.token, id);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  let mine = await inbox(bob.token);
  assert.equal(mine.requests.length, 0);
  assert.equal(mine.conversations.length, 1);
  assert.equal(mine.conversations[0].state, 'open');
  assert.equal(mine.conversations[0].role, 'recipient');
  let theirs = await inbox(alice.token);
  assert.equal(theirs.sent.length, 0);
  assert.equal(theirs.conversations[0].state, 'open');

  assert.equal((await send(bob.token, { conversation_id: id, body: 'Happy to. What did you think of section two?' })).statusCode, 204);
  assert.equal((await send(alice.token, { conversation_id: id, subject: 'Re: Hello', body: 'It was the best part.' })).statusCode, 204);
  const full = (await thread(alice.token, id)).json();
  assert.deepEqual(full.messages.map((m: { from: string; body: string }) => [m.from, m.body]), [
    ['me', 'I would like to talk about your take.'], ['them', 'Happy to. What did you think of section two?'], ['me', 'It was the best part.'],
  ]);
  theirs = await inbox(alice.token);
  assert.equal(theirs.conversations[0].unread, 1);
  assert.equal(theirs.conversations[0].last_message.body, 'It was the best part.');
});

h.t('Scenario: A silent decline - the recipient says no, the sender sees nothing change, and cannot ask again', async () => {
  const { alice, bob, id } = await requested();
  const before = await inbox(alice.token);
  const res = await decline(bob.token, id);
  assert.equal(res.statusCode, 204);
  const after = await inbox(alice.token);
  assert.deepEqual(after.sent, before.sent); // still "pending", not a word different
  assert.equal(after.sent[0].state, 'pending');
  assert.equal((await inbox(bob.token)).requests.length, 0); // gone from the recipient's Requests
  assert.equal((await pitch(alice.token, 'bob', { body: 'Second try' })).statusCode, 409);
  assert.equal((await send(alice.token, { conversation_id: id, body: 'Please?' })).json().error, 'awaiting_acceptance'); // the same answer as while it waited
  assert.equal((await send(bob.token, { conversation_id: id, body: 'Changed my mind' })).statusCode, 409);
});

h.t('Scenario: Only the person asked can accept or decline, once, and a decline is final', async () => {
  const { alice, bob, id } = await requested();
  const carol = await h.member('carol');
  for (const who of [alice.token, carol.token]) {
    assert.equal((await accept(who, id)).statusCode, 404);
    assert.equal((await decline(who, id)).statusCode, 404);
  }
  assert.equal((await accept(bob.token, '00000000-0000-4000-8000-0000000000ff')).statusCode, 404);
  assert.equal((await accept(undefined, id)).statusCode, 401);
  assert.equal((await accept(bob.token, id)).statusCode, 204);
  assert.equal((await accept(bob.token, id)).statusCode, 204); // twice is the same as once

  const second = await requested2();
  assert.equal((await decline(second.bob.token, second.id)).statusCode, 204);
  assert.equal((await decline(second.bob.token, second.id)).statusCode, 204);
  const late = await accept(second.bob.token, second.id);
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'closed');
});

async function requested2() {
  const erin = await h.member('erin');
  const dave = await h.member('dave');
  await pitch(erin.token, 'dave');
  return { bob: dave, id: (await inbox(dave.token)).requests[0].id as string };
}

h.t('Scenario: Replies are only for open conversations between the two of them', async () => {
  const { alice, id } = await opened();
  const carol = await h.member('carol');
  assert.equal((await send(carol.token, { conversation_id: id, body: 'Butting in' })).statusCode, 404);
  assert.equal((await send(alice.token, { conversation_id: '00000000-0000-4000-8000-0000000000ff', body: 'x' })).statusCode, 404);
  assert.equal((await send(alice.token, { conversation_id: id, body: 'see http://example.com' })).statusCode, 400);
  assert.equal((await send(alice.token, { conversation_id: id, body: '' })).statusCode, 400);
});

h.t('Scenario: A reply counts toward the daily limit', async () => {
  const small = await h.build({ messagesPerDay: 2 });
  const { alice, bob, id } = await (async () => { const t = await requested(); await accept(t.bob.token, t.id); return t; })();
  assert.equal((await send(bob.token, { conversation_id: id, body: 'one' }, small)).statusCode, 204);
  assert.equal((await send(bob.token, { conversation_id: id, body: 'two' }, small)).statusCode, 204);
  assert.equal((await send(bob.token, { conversation_id: id, body: 'three' }, small)).statusCode, 429); // two a day, and these are bob's two
  assert.equal((await send(alice.token, { conversation_id: id, body: 'mine are counted separately' }, small)).statusCode, 204);
});

h.t('Scenario: Reading - the recipient marks a message read, and the counts follow; the sender cannot', async () => {
  const { alice, bob, id } = await requested();
  const message = (await thread(bob.token, id)).json().messages[0];
  assert.equal(message.read, false);
  assert.equal((await read(alice.token, message.id)).statusCode, 404); // your own message is not yours to mark
  assert.equal((await read(bob.token, message.id)).statusCode, 204);
  assert.equal((await read(bob.token, message.id)).statusCode, 204);
  assert.equal((await inbox(bob.token)).unread, 0);
  assert.equal((await thread(bob.token, id)).json().messages[0].read, true);
  assert.equal((await read(undefined, message.id)).statusCode, 401);
  assert.equal((await read(bob.token, '00000000-0000-4000-8000-0000000000ff')).statusCode, 404);
});

h.t('Scenario: Hiding a message removes it from your view only - the other person keeps it', async () => {
  const { alice, bob, id } = await opened();
  await send(bob.token, { conversation_id: id, body: 'Second message' });
  const mine = (await thread(bob.token, id)).json().messages;
  const first = mine[0];
  assert.equal((await hide(bob.token, first.id)).statusCode, 204);
  assert.equal((await hide(bob.token, first.id)).statusCode, 204);
  assert.deepEqual((await thread(bob.token, id)).json().messages.map((m: { body: string }) => m.body), ['Second message']);
  assert.equal((await thread(alice.token, id)).json().messages.length, 2);
  assert.equal((await hide(alice.token, '00000000-0000-4000-8000-0000000000ff')).statusCode, 404);
  // Hide everything on one side: the conversation leaves their lists, and stays for the other.
  await hide(bob.token, mine[1].id);
  assert.equal((await inbox(bob.token)).conversations.length, 0);
  assert.equal((await inbox(alice.token)).conversations.length, 1);
});

h.t('Scenario: A conversation is private to its two people', async () => {
  const { id } = await opened();
  const carol = await h.member('carol');
  assert.equal((await thread(carol.token, id)).statusCode, 404);
  assert.equal((await thread(undefined, id)).statusCode, 401);
  assert.equal((await thread(carol.token, 'not-an-id')).statusCode, 404);
});

h.t('Scenario: Blocking hides the conversation from both, drops what is sent meanwhile, and unblocking brings it back', async () => {
  const { alice, bob, id } = await opened();
  await h.post(bob.token, '/me/blocks', { public_id: await h.publicId('alice') });
  assert.equal((await inbox(bob.token)).conversations.length, 0);
  assert.equal((await inbox(alice.token)).conversations.length, 0);
  assert.equal((await thread(alice.token, id)).statusCode, 404);
  const before = (await h.rows('SELECT 1 FROM messages')).length;
  assert.equal((await send(alice.token, { conversation_id: id, body: 'Are you there?' })).statusCode, 204); // looks sent
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, before); // nothing was kept
  await h.call(bob.token, 'DELETE', `/me/blocks/${await h.publicId('alice')}`);
  assert.equal((await inbox(bob.token)).conversations.length, 1);
  assert.equal((await inbox(alice.token)).conversations.length, 1);
});

h.t('Scenario: What an inbox shows - exactly these fields, and nothing private about anyone', async () => {
  const { alice, bob, id } = await opened();
  await send(bob.token, { conversation_id: id, body: 'Reply' });
  const mine = await inbox(alice.token);
  assert.deepEqual(Object.keys(mine).sort(), ['conversations', 'cursor', 'requests', 'sent', 'unread']);
  const [c] = mine.conversations;
  assert.deepEqual(Object.keys(c).sort(), ['article_id', 'created_at', 'id', 'last_message', 'last_message_at', 'other', 'role', 'state', 'unread']);
  assert.deepEqual(Object.keys(c.last_message).sort(), ['body', 'created_at', 'from', 'id', 'read', 'subject']);
  assert.deepEqual(Object.keys(c.other).sort(), ['deleted', 'display_name', 'industry', 'interests', 'public_id']);
  const text = JSON.stringify([mine, (await thread(alice.token, id)).json()]);
  const [account] = await h.rows(`SELECT id, ref FROM accounts WHERE email = $1`, [USERS.bob.email]);
  for (const secret of [USERS.bob.email, USERS.bob.sub, account.id, account.ref, USERS.alice.email, alice.ref]) assert.ok(!text.includes(secret), secret);
  assert.equal((await h.call(alice.token, 'GET', '/me/inbox')).headers['cache-control'], 'no-store');
  assert.equal((await h.call(undefined, 'GET', '/me/inbox')).statusCode, 401);
});

h.t('Scenario: Polling - only what changed since the cursor, a cursor that does not move for others\' activity, and every kind of change', async () => {
  const { alice, bob, id } = await requested();
  const start = await changes(alice.token, 0);
  assert.equal(start.conversations.length, 1);
  assert.ok(start.cursor > 0);
  assert.deepEqual((await changes(alice.token, start.cursor)).conversations, []); // nothing new
  assert.equal((await changes(alice.token, start.cursor)).cursor, start.cursor);

  // Other people's activity does not show, and does not move my cursor (so it tells me nothing about the rest of the app).
  const carol = await h.member('carol');
  const dave = await h.member('dave');
  await pitch(carol.token, 'dave');
  const quiet = await changes(alice.token, start.cursor);
  assert.deepEqual([quiet.conversations.length, quiet.cursor], [0, start.cursor]);

  await accept(bob.token, id); // a change of state reaches the sender
  const afterAccept = await changes(alice.token, start.cursor);
  assert.equal(afterAccept.conversations.length, 1);
  assert.equal(afterAccept.conversations[0].state, 'open');
  assert.ok(afterAccept.cursor > start.cursor);

  await send(bob.token, { conversation_id: id, body: 'A new message' }); // a new message
  const afterMessage = await changes(alice.token, afterAccept.cursor);
  assert.equal(afterMessage.conversations[0].last_message.body, 'A new message');
  assert.equal(afterMessage.unread, 1);

  await hide(alice.token, afterMessage.conversations[0].last_message.id); // hiding is a change too
  assert.equal((await changes(alice.token, afterMessage.cursor)).conversations.length, 1);
  void dave;
});

h.t('Scenario: The person asked also hears about a decline in the feed, so their app can drop it', async () => {
  const { bob, id } = await requested();
  const start = await changes(bob.token, 0);
  await decline(bob.token, id);
  const after = await changes(bob.token, start.cursor);
  assert.equal(after.conversations.length, 1);
  assert.equal(after.conversations[0].state, 'declined');
  assert.equal(after.conversations[0].role, 'recipient');
});

h.t('Scenario: Bad cursors - 400', async () => {
  const me = await h.member('alice');
  for (const since of ['-1', 'x', '1.5', '']) assert.equal((await h.call(me.token, 'GET', `/me/inbox/changes?since=${since}`)).statusCode, 400, since);
  assert.equal((await h.call(me.token, 'GET', '/me/inbox/changes')).statusCode, 200); // none means from the start
});
