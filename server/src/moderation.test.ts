// The moderator's tools: the queue of reports, suspending, banning, resolving, removing a message, a log of everything done,
// and the automatic pause when several different readers report the same person.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../testkit/harness.ts';
import { createModeration } from './moderation.ts';
import { runModerate } from './moderate.ts';

const h = useHarness('moderation');
const DAY_MS = 86_400_000;
const mod = () => createModeration(h.pool);
const report = async (token: string, target: UserKey, reason = 'spam') => h.post(token, '/me/reports', { public_id: await h.publicId(target), reason });
const send = (token: string, body: unknown) => h.post(token, '/me/messages', body);
const inbox = async (token: string) => (await h.call(token, 'GET', '/me/inbox')).json();
const suspendedUntil = async (user: UserKey) => (await h.rows('SELECT suspended_until FROM accounts WHERE email = $1', [USERS[user].email]))[0].suspended_until as Date | null;

h.t('Scenario: The queue - open reports, oldest first, with what was reported, and nothing already dealt with', async () => {
  const alice = await h.member('alice');
  const carol = await h.member('carol');
  await h.member('bob');
  await h.member('dave');
  await h.post(alice.token, '/me/reports', { public_id: await h.publicId('bob'), reason: 'harassment', note: 'Odd messages' });
  h.clock.now = new Date(h.clock.now.getTime() + 60_000);
  await report(carol.token, 'dave', 'scam');
  const open = await mod().openReports();
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((r) => [r.kind, r.reason, r.reported?.display_name]), [['profile', 'harassment', 'bob'], ['profile', 'scam', 'dave']]);
  assert.equal(open[0].note, 'Odd messages');
  assert.equal(open[0].reported?.public_id, await h.publicId('bob'));
  assert.match(open[0].id, /^[0-9a-f-]{36}$/);
  await mod().resolveReport(open[0].id, 'resolved', 'warned', h.clock.now);
  assert.equal((await mod().openReports()).length, 1);
});

h.t('Scenario: Looking at one report shows the frozen copy; an unknown one is nothing', async () => {
  const alice = await h.member('alice');
  await h.member('bob', { name: 'Bob B' });
  await report(alice.token, 'bob');
  const [r] = await mod().openReports();
  const detail = await mod().showReport(r.id);
  assert.equal(detail?.snapshot.display_name, 'Bob B');
  assert.equal(await mod().showReport('00000000-0000-4000-8000-0000000000ff'), undefined);
  assert.equal(await mod().showReport('nope'), undefined);
});

h.t('Scenario: Suspending a reader hides them, stops their messages and requests to them, and can be lifted - and it is all logged', async () => {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  const carol = await h.member('carol', { saved: [0] });
  const id = await h.publicId('bob');
  assert.equal(await mod().suspend(id, 7, 'harassing readers', h.clock.now), true);
  assert.equal((await suspendedUntil('bob'))?.getTime(), h.clock.now.getTime() + 7 * DAY_MS);
  assert.equal((await send(bob.token, { to: await h.publicId('alice'), body: 'hi' })).statusCode, 403); // cannot send
  assert.equal((await send(alice.token, { to: id, body: 'hi' })).statusCode, 404); // cannot be written to
  assert.equal((await h.call(alice.token, 'GET', `/readers/${id}`)).statusCode, 404); // hidden
  assert.equal(await mod().unsuspend(id, 'resolved', h.clock.now), true);
  assert.equal(await suspendedUntil('bob'), null);
  assert.equal((await send(alice.token, { to: id, body: 'hi' })).statusCode, 204);
  const log = await mod().log(10);
  assert.deepEqual(log.map((l) => [l.action, l.actor]), [['unsuspend', 'owner'], ['suspend', 'owner']]);
  assert.equal(log[1].reason, 'harassing readers');
  void carol;
  assert.equal(await mod().suspend('00000000-0000-4000-8000-0000000000ff', 1, '', h.clock.now), false);
  assert.equal(await mod().suspend('nope', 1, '', h.clock.now), false);
});

h.t('Scenario: A ban ends access: off the list, sessions gone, and they cannot sign back in even when the app is open to any Google account', async () => {
  const open = await h.build({ allowAny: true });
  const bob = await h.member('bob');
  const second = await h.signIn('bob'); // another phone
  assert.equal(await mod().ban(await h.publicId('bob'), 'repeated scams', h.clock.now), true);
  assert.equal((await h.rows(`SELECT 1 FROM allowed_emails WHERE email = 'bob@example.com'`)).length, 0);
  assert.equal((await h.rows(`SELECT 1 FROM sessions WHERE email = 'bob@example.com'`)).length, 0);
  assert.equal((await h.call(bob.token, 'GET', '/auth/session')).statusCode, 401);
  assert.equal((await h.call(second.token, 'GET', '/me/messaging-settings')).statusCode, 401);
  const again = await h.signIn('bob', open);
  assert.deepEqual(again.body, { status: 'pending' }); // told nothing
  assert.equal((await h.rows(`SELECT 1 FROM sessions WHERE email = 'bob@example.com'`)).length, 0);
  assert.equal((await h.call(undefined, 'GET', `/readers/${await h.publicId('bob')}`)).statusCode, 401);
  const [account] = await h.rows(`SELECT banned_at FROM accounts WHERE email = 'bob@example.com'`);
  assert.ok(account.banned_at);
  assert.equal((await mod().ban(await h.publicId('bob'), 'again', h.clock.now)), true); // twice is fine
  assert.equal((await mod().log(5))[0].action, 'ban');
});

h.t('Scenario: Resolving a report - marked, dated, with what was done; a report already dealt with cannot be dealt with twice', async () => {
  const alice = await h.member('alice');
  await h.member('bob');
  await report(alice.token, 'bob');
  const [r] = await mod().openReports();
  assert.equal(await mod().resolveReport(r.id, 'dismissed', 'nothing wrong', h.clock.now), true);
  const [row] = await h.rows('SELECT status, handled_at, action FROM reports');
  assert.deepEqual({ status: row.status, action: row.action, at: row.handled_at.getTime() }, { status: 'dismissed', action: 'nothing wrong', at: h.clock.now.getTime() });
  assert.equal(await mod().resolveReport(r.id, 'resolved', 'again', h.clock.now), false);
  assert.equal(await mod().resolveReport('00000000-0000-4000-8000-0000000000ff', 'resolved', 'x', h.clock.now), false);
  assert.equal((await mod().log(5))[0].action, 'resolve');
});

h.t('Scenario: Removing a message - it is gone for both, and the report keeps its copy', async () => {
  const alice = await h.member('alice');
  const bob = await h.member('bob');
  await send(alice.token, { to: await h.publicId('bob'), body: 'A message that breaks the rules.' });
  const message = (await inbox(bob.token)).requests[0].last_message.id as string;
  await h.post(bob.token, '/me/reports', { message_id: message, reason: 'scam' });
  assert.equal(await mod().deleteMessage(message, 'scam', h.clock.now), true);
  assert.equal((await h.rows('SELECT 1 FROM messages')).length, 0);
  assert.equal((await h.rows('SELECT 1 FROM conversations')).length, 0); // the last message took the conversation
  assert.equal((await inbox(alice.token)).sent.length, 0);
  assert.equal((await h.rows('SELECT snapshot FROM reports'))[0].snapshot.message.body, 'A message that breaks the rules.');
  assert.equal(await mod().deleteMessage(message, 'again', h.clock.now), false);
  assert.equal((await mod().log(5))[0].action, 'delete_message');
});

h.t('Scenario: Three different readers reporting the same person in a week pauses them until the owner looks', async () => {
  const [a, b, c] = [await h.member('alice'), await h.member('bob'), await h.member('carol')];
  await h.member('dave');
  await report(a.token, 'dave');
  await report(b.token, 'dave', 'harassment');
  assert.equal(await suspendedUntil('dave'), null); // two is not enough
  await report(c.token, 'dave', 'scam');
  assert.equal((await suspendedUntil('dave'))?.getTime(), h.clock.now.getTime() + 7 * DAY_MS);
  const [entry] = await mod().log(1);
  assert.deepEqual([entry.action, entry.actor], ['auto_suspend', 'system']);
});

h.t('Scenario: The same reader reporting again does not add up - two different readers are not three', async () => {
  const [a, b] = [await h.member('alice'), await h.member('bob')];
  await h.member('dave');
  await report(a.token, 'dave');
  h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
  await report(a.token, 'dave', 'scam'); // a second report from the same person, a day later
  await report(b.token, 'dave');
  assert.equal((await h.rows('SELECT 1 FROM reports')).length, 3);
  assert.equal(await suspendedUntil('dave'), null);
});

h.t('Scenario: Reports more than a week old do not count', async () => {
  const [a, b, c] = [await h.member('alice'), await h.member('bob'), await h.member('carol')];
  await h.member('dave');
  await report(a.token, 'dave');
  await report(b.token, 'dave');
  h.clock.now = new Date(h.clock.now.getTime() + 8 * DAY_MS);
  await report(c.token, 'dave');
  assert.equal(await suspendedUntil('dave'), null);
});

h.t('Scenario: A report of a message counts like any other', async () => {
  const [a, b, erin] = [await h.member('alice'), await h.member('bob'), await h.member('erin')];
  const dave = await h.member('dave');
  await send(dave.token, { to: await h.publicId('erin'), body: 'Buy my course.' });
  const message = (await inbox(erin.token)).requests[0].last_message.id as string;
  await h.post(erin.token, '/me/reports', { message_id: message, reason: 'scam' });
  await report(a.token, 'dave');
  assert.equal(await suspendedUntil('dave'), null);
  await report(b.token, 'dave');
  assert.ok(await suspendedUntil('dave'));
});

h.t('Scenario: The command line - lists the queue, acts, and refuses nonsense', async () => {
  const alice = await h.member('alice');
  await h.member('bob');
  await report(alice.token, 'bob', 'harassment');
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);
  const run = (...argv: string[]) => runModerate(argv, mod(), out, () => h.clock.now);
  assert.equal(await run('reports'), 0);
  assert.ok(lines.join('\n').includes('harassment'));
  assert.ok(lines.join('\n').includes(await h.publicId('bob')));
  const [r] = await mod().openReports();
  lines.length = 0;
  assert.equal(await run('show', r.id), 0);
  assert.ok(lines.join('\n').includes('"display_name"') || lines.join('\n').includes('display_name'));
  assert.equal(await run('suspend', await h.publicId('bob'), '3', 'a', 'few', 'words'), 0);
  assert.equal((await suspendedUntil('bob'))?.getTime(), h.clock.now.getTime() + 3 * DAY_MS);
  assert.equal((await mod().log(1))[0].reason, 'a few words');
  assert.equal(await run('resolve', r.id, 'resolved', 'suspended', 'for', '3', 'days'), 0);
  assert.equal(await run('log', '5'), 0);
  // Mistakes are refused and change nothing.
  assert.equal(await run('suspend', await h.publicId('bob'), 'many'), 2);
  assert.equal(await run('suspend', await h.publicId('bob'), '0'), 2);
  assert.equal(await run('suspend'), 2);
  assert.equal(await run('resolve', r.id, 'maybe'), 2);
  assert.equal(await run('explode'), 2);
  assert.equal(await run(), 2);
  assert.equal(await run('show', '00000000-0000-4000-8000-0000000000ff'), 1);
  assert.equal(await run('ban', '00000000-0000-4000-8000-0000000000ff'), 1);
  assert.ok(lines.some((l) => /usage/i.test(l)));
});
