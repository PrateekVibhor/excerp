// Reporting a message: the moderator gets a frozen copy of the message and of who sent it, the reporter no longer sees it.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';
import { purgeExpired } from './messageExpiry.ts';

const h = useHarness('msgrep');
const send = (token: string, body: unknown) => h.post(token, '/me/messages', body);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();
const report = (token: string | undefined, body: unknown, app = h.app) => h.post(token, '/me/reports', body, app);

async function received(text = 'You should really buy my course, it will change your life.') {
  const alice = await h.member('alice', { name: 'Alice A', industry: 'Finance', interests: ['Safety'] });
  const bob = await h.member('bob');
  await send(alice.token, { to: await h.publicId('bob'), subject: 'Opportunity', body: text, article_id: h.articles[1] });
  const request = (await inbox(bob.token)).requests[0];
  return { alice, bob, conversation: request.id as string, message: request.last_message.id as string };
}

h.t('Scenario: Reporting a message keeps a frozen copy of it and of the sender, and hides it from the reporter', async () => {
  const { alice, bob, message, conversation } = await received();
  const res = await report(bob.token, { message_id: message, reason: 'scam', note: 'A sales pitch' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  const [r] = await h.rows('SELECT * FROM reports');
  assert.equal(r.kind, 'message');
  assert.equal(r.message_id, message);
  assert.equal(r.reason, 'scam');
  assert.equal(r.status, 'open');
  assert.equal(r.snapshot.message.subject, 'Opportunity');
  assert.equal(r.snapshot.message.body, 'You should really buy my course, it will change your life.');
  assert.equal(r.snapshot.sender.display_name, 'Alice A');
  assert.equal(r.snapshot.sender.industry, 'Finance');
  assert.equal(r.snapshot.sender.public_id, await h.publicId('alice'));
  assert.equal(r.snapshot.conversation_id, conversation);
  assert.equal(r.snapshot.article_id, h.articles[1]);
  const [{ id: sender }] = await h.rows(`SELECT id FROM accounts WHERE email = 'alice@example.com'`);
  assert.equal(r.reported_id, sender);
  assert.equal((await inbox(bob.token)).requests.length, 0); // gone from the reporter's view
  assert.equal((await h.call(bob.token, 'GET', `/me/conversations/${conversation}`)).statusCode, 404);
  assert.equal((await h.call(alice.token, 'GET', `/me/conversations/${conversation}`)).json().messages.length, 1); // the sender is not told and keeps their copy
});

h.t('Scenario: The copy outlives the message', async () => {
  const { bob, message } = await received();
  await report(bob.token, { message_id: message, reason: 'spam' });
  await h.advance(366);
  await purgeExpired(h.pool, h.clock.now);
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 0);
  const [r] = await h.rows('SELECT snapshot FROM reports');
  assert.equal(r.snapshot.message.body, 'You should really buy my course, it will change your life.');
});

h.t('Scenario: Only a message you can see, and not your own', async () => {
  const { alice, message } = await received();
  const carol = await h.member('carol');
  assert.equal((await report(carol.token, { message_id: message, reason: 'spam' })).statusCode, 404); // not a message of hers
  assert.equal((await report(alice.token, { message_id: message, reason: 'spam' })).statusCode, 400); // her own
  assert.equal((await report(carol.token, { message_id: '00000000-0000-4000-8000-0000000000ff', reason: 'spam' })).statusCode, 404);
  assert.equal((await report(undefined, { message_id: message, reason: 'spam' })).statusCode, 401);
  assert.equal((await h.rows('SELECT 1 FROM reports')).length, 0);
});

h.t('Scenario: Name a message or a reader, not both and not neither; the other rules are as for a reader', async () => {
  const { bob, message } = await received();
  const publicId = await h.publicId('alice');
  for (const body of [{ reason: 'spam' }, { message_id: message, public_id: publicId, reason: 'spam' }, { message_id: 'nope', reason: 'spam' }, { message_id: message, reason: 'because' }, { message_id: message, reason: 'spam', note: 'x'.repeat(501) }]) {
    assert.equal((await report(bob.token, body)).statusCode, 400, JSON.stringify(body));
  }
});

h.t('Scenario: Reporting and blocking in one go, and the same message twice makes one report', async () => {
  const { alice, bob, message } = await received();
  await report(bob.token, { message_id: message, reason: 'harassment', also_block: true });
  await report(bob.token, { message_id: message, reason: 'harassment' });
  assert.equal((await h.rows('SELECT 1 FROM reports')).length, 1);
  assert.equal((await h.rows('SELECT 1 FROM blocks')).length, 1);
  assert.equal((await inbox(alice.token)).sent.length, 0); // blocked: the conversation is out of sight for both
});

h.t('Scenario: Message reports share the daily allowance with the others', async () => {
  const small = await h.build({ reportsPerDay: 1 });
  const { bob, message } = await received();
  assert.equal((await report(bob.token, { public_id: await h.publicId('alice'), reason: 'spam' }, small)).statusCode, 204);
  const other = await h.member('carol');
  assert.equal((await report(bob.token, { public_id: await h.publicId('carol'), reason: 'spam' }, small)).statusCode, 429);
  void message; void other;
});
