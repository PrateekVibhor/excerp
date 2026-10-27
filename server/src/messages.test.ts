// Sending: a first message is a one-shot request to someone who takes messages. Text only, a few a day, and nothing tells the sender
// how it was received.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../testkit/harness.ts';

const h = useHarness('messages');
const DAY_MS = 86_400_000;
const send = (token: string | undefined, body: unknown, app = h.app) => h.post(token, '/me/messages', body, app);
const pitch = async (token: string | undefined, to: UserKey, extra: Record<string, unknown> = {}, app = h.app) =>
  send(token, { to: await h.publicId(to), subject: 'Your take on agents', body: 'I enjoyed it, would love to compare notes.', ...extra }, app);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();
const rows = (sql: string, args: unknown[] = []) => h.rows(sql, args);

h.t('Scenario: A request is sent - 204, and the recipient finds it in Requests with the sender\'s card, while the sender sees it as pending', async () => {
  const bob = await h.member('bob');
  const alice = await h.member('alice');
  const article = h.articles[1];
  const res = await pitch(alice.token, 'bob', { article_id: article });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal(res.headers['cache-control'], 'no-store');

  const theirs = await inbox(bob.token);
  assert.equal(theirs.requests.length, 1);
  const [request] = theirs.requests;
  assert.equal(request.state, 'request');
  assert.equal(request.role, 'recipient');
  assert.equal(request.article_id, article);
  assert.deepEqual(request.other, { public_id: await h.publicId('alice'), display_name: 'alice', industry: 'Software', interests: ['Cloud'], deleted: false });
  assert.deepEqual({ from: request.last_message.from, subject: request.last_message.subject, body: request.last_message.body, read: request.last_message.read }, { from: 'them', subject: 'Your take on agents', body: 'I enjoyed it, would love to compare notes.', read: false });
  assert.equal(request.unread, 1);
  assert.equal(theirs.unread, 1);

  const mine = await inbox(alice.token);
  assert.equal(mine.requests.length, 0);
  assert.equal(mine.sent.length, 1);
  assert.equal(mine.sent[0].state, 'pending');
  assert.equal(mine.sent[0].role, 'initiator');
  assert.equal(mine.sent[0].last_message.from, 'me');
  assert.equal(mine.unread, 0);

  const [message] = await rows('SELECT created_at, expires_at FROM messages');
  assert.equal(message.expires_at.getTime() - message.created_at.getTime(), 365 * DAY_MS); // gone after 12 months
});

h.t('Scenario: Not signed in - 401', async () => {
  await h.member('bob');
  assert.equal((await pitch(undefined, 'bob')).statusCode, 401);
  assert.equal((await pitch('made-up', 'bob')).statusCode, 401);
});

h.t('Scenario: Only a reader who has opted in, confirmed 18+ and the Terms, and verified an article may send', async () => {
  await h.member('bob');
  const noConfirm = await h.signIn('alice'); // never turned anything on, so never confirmed
  await h.sync(noConfirm.token, 0, { profile: { display_name: 'alice', industry: 'Software', interests: ['Cloud'], updated_at: h.at(-1) }, verified: [{ article_id: h.articles[0], verified_at: h.at(-5), topic: 'Cloud' }] });
  let res = await pitch(noConfirm.token, 'bob');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'confirmation required');

  const carol = await h.reader('carol', { accepts: true }); // confirmed, but has not verified anything
  res = await pitch(carol.token, 'bob');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'verify_first');
  assert.equal((await rows('SELECT 1 FROM conversations')).length, 0);
});

h.t('Scenario: A suspended sender is refused', async () => {
  await h.member('bob');
  const alice = await h.member('alice');
  await rows(`UPDATE accounts SET suspended_until = $1 WHERE email = $2`, [new Date(h.clock.now.getTime() + DAY_MS), USERS.alice.email]);
  const res = await pitch(alice.token, 'bob');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'suspended');
});

h.t('Scenario: A recipient who cannot be written to is "not found", the same whatever the reason', async () => {
  const alice = await h.member('alice');
  await h.member('bob', { accepts: false }); // visible, but takes no messages
  await h.member('carol', { visible: false });
  await h.member('dave');
  await h.rows(`UPDATE accounts SET suspended_until = $1 WHERE email = $2`, [new Date(h.clock.now.getTime() + DAY_MS), USERS.dave.email]);
  const answers = [
    await pitch(alice.token, 'bob'),
    await pitch(alice.token, 'carol'),
    await pitch(alice.token, 'dave'),
    await send(alice.token, { to: '00000000-0000-4000-8000-0000000000ff', body: 'hi' }),
    await pitch(alice.token, 'alice'), // yourself
  ];
  for (const a of answers) assert.equal(a.statusCode, 404);
  assert.equal(new Set(answers.map((a) => a.body)).size, 1);
  assert.equal((await send(alice.token, { to: 'not-an-id', body: 'hi' })).statusCode, 400);
  assert.equal((await rows('SELECT 1 FROM conversations')).length, 0);
});

h.t('Scenario: Blocked either way - it looks sent, and nothing is delivered', async () => {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  const carol = await h.member('carol');
  await h.post(bob.token, '/me/blocks', { public_id: await h.publicId('alice') }); // bob blocked alice
  await h.post(alice.token, '/me/blocks', { public_id: await h.publicId('carol') }); // alice blocked carol
  const toBob = await pitch(alice.token, 'bob');
  const toCarol = await pitch(carol.token, 'alice');
  const normal = await pitch(bob.token, 'carol');
  assert.deepEqual([toBob.statusCode, toCarol.statusCode, normal.statusCode], [204, 204, 204]);
  assert.equal((await rows('SELECT 1 FROM conversations')).length, 1); // only the one that was not blocked
  assert.equal((await inbox(bob.token)).requests.length, 0);
  assert.equal((await inbox(alice.token)).requests.length, 0);
  assert.equal((await inbox(alice.token)).sent.length, 0); // it does not even show as sent: nothing exists
});

h.t('Scenario: One request only - a second to the same person is refused while it waits, and by either side', async () => {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  assert.equal((await pitch(alice.token, 'bob')).statusCode, 204);
  const again = await pitch(alice.token, 'bob', { body: 'Hello again' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_requested');
  assert.equal((await pitch(bob.token, 'alice')).statusCode, 409); // and not the other way round either
  assert.equal((await rows('SELECT 1 FROM messages')).length, 1);
});

h.t('Scenario: While a request waits, neither side can write into it', async () => {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  await pitch(alice.token, 'bob');
  const id = (await inbox(bob.token)).requests[0].id;
  const fromSender = await send(alice.token, { conversation_id: id, body: 'Are you there?' });
  assert.equal(fromSender.statusCode, 409);
  assert.equal(fromSender.json().error, 'awaiting_acceptance');
  const fromRecipient = await send(bob.token, { conversation_id: id, body: 'Sure' });
  assert.equal(fromRecipient.statusCode, 409);
  assert.equal(fromRecipient.json().error, 'accept_first');
  assert.equal((await rows('SELECT 1 FROM messages')).length, 1);
});

h.t('Scenario: Text only - a link, a bad length, control characters, or the wrong kind of value is refused with nothing stored', async () => {
  await h.member('bob');
  const alice = await h.member('alice');
  const to = await h.publicId('bob');
  const bad: Array<[unknown, string?]> = [
    [{ to, body: 'see https://example.com' }, 'no links'],
    [{ to, subject: 'visit example.com', body: 'hi' }, 'no links'],
    [{ to, body: 'mail me at a@b.co' }, 'no links'],
    [{ to, body: '' }], [{ to, body: '   ' }], [{ to }], [{ to, body: 'x'.repeat(2001) }], [{ to, subject: 'x'.repeat(121), body: 'hi' }],
    [{ to, body: 5 }], [{ to, subject: 5, body: 'hi' }], [{ to, body: 'a\u0000b' }],
    [{ to, body: 'hi', article_id: 'nope' }], [{ to, body: 'hi', article_id: '00000000-0000-4000-8000-0000000000ff' }],
    [{ body: 'hi' }], [{ to, conversation_id: '00000000-0000-4000-8000-0000000000aa', body: 'hi' }], [null], [[]], [{}],
  ];
  for (const [body, error] of bad) {
    const res = await send(alice.token, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 70));
    if (error) assert.equal(res.json().error, error);
  }
  assert.equal((await rows('SELECT 1 FROM conversations')).length, 0);
  assert.equal((await rows('SELECT 1 FROM messages')).length, 0);
});

h.t('Scenario: Extra fields are ignored, and a subject is optional', async () => {
  await h.member('bob');
  const alice = await h.member('alice');
  assert.equal((await send(alice.token, { to: await h.publicId('bob'), body: 'Hello', sender: 'someone else', state: 'open', read: true })).statusCode, 204);
  const [c] = await rows('SELECT state FROM conversations');
  assert.equal(c.state, 'request'); // the sender cannot choose how it starts
  assert.equal((await rows('SELECT subject FROM messages'))[0].subject, '');
});

h.t('Scenario: A few requests a day - the next one is refused, and it is allowed again a day later', async () => {
  const small = await h.build({ pitchesPerDay: 2 });
  const alice = await h.member('alice');
  for (const u of ['bob', 'carol', 'dave'] as const) await h.member(u);
  assert.equal((await pitch(alice.token, 'bob', {}, small)).statusCode, 204);
  assert.equal((await pitch(alice.token, 'carol', {}, small)).statusCode, 204);
  const third = await pitch(alice.token, 'dave', {}, small);
  assert.equal(third.statusCode, 429);
  assert.equal((await rows('SELECT 1 FROM conversations')).length, 2);
  h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
  assert.equal((await pitch(alice.token, 'dave', {}, small)).statusCode, 204);
});

h.t('Scenario: The same text to many people is stopped - a message sent to three people cannot go to a fourth', async () => {
  const alice = await h.member('alice');
  for (const u of ['bob', 'carol', 'dave', 'erin', 'frank'] as const) await h.member(u);
  const same = { subject: 'Hi', body: 'Check out my newsletter, it is great.' };
  for (const u of ['bob', 'carol', 'dave'] as const) assert.equal((await pitch(alice.token, u, same)).statusCode, 204);
  const res = await pitch(alice.token, 'erin', same);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'repeated message');
  assert.equal((await pitch(alice.token, 'erin', { body: 'A different note, written for you.' })).statusCode, 204);
  // Capitals and spacing do not get around it.
  const disguised = await pitch(alice.token, 'frank', { subject: 'Hello', body: '  CHECK out my   newsletter, it is great. ' });
  assert.equal(disguised.statusCode, 429);
});
