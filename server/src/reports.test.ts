// Reporting a reader: a frozen copy of their profile is kept for the moderator, and the reporter can block in the same go.
import assert from 'node:assert/strict';
import { useHarness, type UserKey } from '../testkit/harness.ts';

const h = useHarness('reports');
const A0 = () => h.articles[0];
const report = async (token: string | undefined, user: UserKey, body: Record<string, unknown> = {}, app = h.app) =>
  h.post(token, '/me/reports', { public_id: await h.publicId(user), reason: 'spam', ...body }, app);
const rows = () => h.rows('SELECT * FROM reports ORDER BY created_at, id');

h.t('Scenario: A report is kept with a frozen copy of the profile, and the reporter is told nothing more than "done"', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0], name: 'Bob B', industry: 'Finance', interests: ['Safety', 'Research'] });
  const res = await report(me.token, 'bob', { reason: 'harassment', note: 'Sent me odd messages', article_id: A0() });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  const [r] = await rows();
  assert.equal(r.kind, 'profile');
  assert.equal(r.reason, 'harassment');
  assert.equal(r.note, 'Sent me odd messages');
  assert.equal(r.status, 'open');
  assert.equal(r.message_id, null);
  assert.equal(r.handled_at, null);
  assert.deepEqual(r.snapshot, { public_id: await h.publicId('bob'), display_name: 'Bob B', industry: 'Finance', interests: ['Safety', 'Research'], article_id: A0() });
  const [{ id: reporter }] = await h.rows(`SELECT id FROM accounts WHERE email = 'alice@example.com'`);
  const [{ id: reported }] = await h.rows(`SELECT id FROM accounts WHERE email = 'bob@example.com'`);
  assert.equal(r.reporter_id, reporter);
  assert.equal(r.reported_id, reported);
});

h.t('Scenario: The copy is frozen - renaming afterwards does not change what the moderator sees', async () => {
  const me = await h.reader('alice');
  const bob = await h.reader('bob', { name: 'Bob B' });
  await report(me.token, 'bob');
  await h.sync(bob.token, 0, { profile: { display_name: 'Someone Else', industry: 'Media', interests: ['Cloud'], updated_at: h.at(5) } });
  const [r] = await rows();
  assert.equal(r.snapshot.display_name, 'Bob B');
  assert.equal(r.snapshot.industry, 'Software');
});

h.t('Scenario: Bad input - 400 for the reason, the note and the target; 404 for someone unknown; 401 when not signed in', async () => {
  const me = await h.reader('alice');
  await h.reader('bob');
  for (const body of [{ reason: 'because' }, { reason: '' }, { reason: 5 }, { note: 5 }, { note: 'x'.repeat(501) }, { article_id: 'nope' }, { also_block: 'yes' }]) {
    assert.equal((await report(me.token, 'bob', body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await report(me.token, 'alice')).statusCode, 400); // not yourself
  assert.equal((await h.post(me.token, '/me/reports', { public_id: '00000000-0000-4000-8000-0000000000ff', reason: 'spam' })).statusCode, 404);
  assert.equal((await h.post(me.token, '/me/reports', { reason: 'spam' })).statusCode, 400);
  assert.equal((await report(undefined, 'bob')).statusCode, 401);
  assert.equal((await rows()).length, 0);
  for (const reason of ['spam', 'harassment', 'hate', 'sexual', 'scam', 'other']) assert.equal((await report(me.token, 'bob', { reason, note: '' })).statusCode, 204, reason);
});

h.t('Scenario: Reporting and blocking in one go', async () => {
  const me = await h.reader('alice', { saved: [0] });
  await h.reader('bob', { saved: [0] });
  await report(me.token, 'bob', { also_block: true });
  assert.equal((await h.rows('SELECT 1 FROM blocks')).length, 1);
  assert.deepEqual(((await h.call(me.token, 'GET', `/articles/${A0()}/readers`)).json().readers), []);
});

h.t('Scenario: Reporting the same person again within a day makes no second report; after a day it does', async () => {
  const me = await h.reader('alice');
  await h.reader('bob');
  await report(me.token, 'bob');
  assert.equal((await report(me.token, 'bob', { reason: 'scam' })).statusCode, 204);
  assert.equal((await rows()).length, 1);
  h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
  assert.equal((await report(me.token, 'bob')).statusCode, 204);
  assert.equal((await rows()).length, 2);
});

h.t('Scenario: Too many reports in a day - 429', async () => {
  const me = await h.reader('alice');
  for (const u of ['bob', 'carol', 'dave'] as const) await h.reader(u);
  const small = await h.build({ reportsPerDay: 2 });
  assert.equal((await report(me.token, 'bob', {}, small)).statusCode, 204);
  assert.equal((await report(me.token, 'carol', {}, small)).statusCode, 204);
  assert.equal((await report(me.token, 'dave', {}, small)).statusCode, 429);
  assert.equal((await rows()).length, 2);
});

h.t('Scenario: Someone who has since hidden themselves, or who blocked the reporter, can still be reported', async () => {
  const me = await h.reader('alice');
  const bob = await h.reader('bob');
  const carol = await h.reader('carol');
  const idBob = await h.publicId('bob');
  const idCarol = await h.publicId('carol');
  await h.settings(bob.token, { discoverable: false });
  await h.post(carol.token, '/me/blocks', { public_id: await h.publicId('alice') });
  assert.equal((await h.post(me.token, '/me/reports', { public_id: idBob, reason: 'spam' })).statusCode, 204);
  assert.equal((await h.post(me.token, '/me/reports', { public_id: idCarol, reason: 'spam' })).statusCode, 204);
});

h.t('Scenario: Reports are never given back to anyone through the app', async () => {
  const me = await h.reader('alice');
  await h.reader('bob');
  await report(me.token, 'bob', { note: 'private note' });
  for (const url of ['/me/reports', '/me/blocks', '/me/messaging-settings']) assert.ok(!(await h.call(me.token, 'GET', url)).body.includes('private note'), url);
});
