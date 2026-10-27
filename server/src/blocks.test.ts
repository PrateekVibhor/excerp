// Blocking: you stop seeing each other, and the other person is never told.
import assert from 'node:assert/strict';
import { useHarness, type UserKey } from '../testkit/harness.ts';

const h = useHarness('blocks');
const A0 = () => h.articles[0];
const block = async (token: string | undefined, user: UserKey) => h.post(token, '/me/blocks', { public_id: await h.publicId(user) });
const unblock = async (token: string | undefined, user: UserKey) => h.call(token, 'DELETE', `/me/blocks/${await h.publicId(user)}`);
const list = async (token: string) => (await h.call(token, 'GET', '/me/blocks')).json();
const names = async (token: string) => ((await h.call(token, 'GET', `/articles/${A0()}/readers`)).json().readers as Array<{ display_name: string }>).map((r) => r.display_name);

h.t('Scenario: Blocking someone, listing the people you blocked, and unblocking', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0] });
  const res = await block(me.token, 'bob');
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  const blocked = await list(me.token);
  assert.deepEqual(blocked.blocks.map((b: { public_id: string; display_name: string }) => [b.public_id, b.display_name]), [[await h.publicId('bob'), 'bob']]);
  assert.deepEqual(Object.keys(blocked.blocks[0]).sort(), ['blocked_at', 'display_name', 'public_id']);
  assert.equal((await unblock(me.token, 'bob')).statusCode, 204);
  assert.deepEqual((await list(me.token)).blocks, []);
});

h.t('Scenario: Blocking twice, or unblocking someone you did not block, is harmless', async () => {
  const me = await h.reader('alice');
  await h.reader('bob');
  assert.equal((await block(me.token, 'bob')).statusCode, 204);
  assert.equal((await block(me.token, 'bob')).statusCode, 204);
  assert.equal((await h.rows('SELECT 1 FROM blocks')).length, 1);
  assert.equal((await unblock(me.token, 'bob')).statusCode, 204);
  assert.equal((await unblock(me.token, 'bob')).statusCode, 204);
});

h.t('Scenario: You cannot block yourself, and an unknown reader is not found', async () => {
  const me = await h.reader('alice');
  assert.equal((await block(me.token, 'alice')).statusCode, 400);
  assert.equal((await h.post(me.token, '/me/blocks', { public_id: '00000000-0000-4000-8000-0000000000ff' })).statusCode, 404);
  for (const body of [{ public_id: 'nope' }, { public_id: 5 }, {}, null]) assert.equal((await h.post(me.token, '/me/blocks', body)).statusCode, 400, JSON.stringify(body));
  assert.equal((await h.rows('SELECT 1 FROM blocks')).length, 0);
});

h.t('Scenario: Not signed in - 401', async () => {
  await h.reader('bob');
  assert.equal((await block(undefined, 'bob')).statusCode, 401);
  assert.equal((await h.call(undefined, 'GET', '/me/blocks')).statusCode, 401);
  assert.equal((await unblock('made-up', 'bob')).statusCode, 401);
});

h.t('Scenario: Neither of you sees the other any more, and unblocking brings it back', async () => {
  const me = await h.reader('alice', { saved: [0] });
  const bob = await h.reader('bob', { saved: [0] });
  await h.reader('carol', { saved: [0] });
  assert.deepEqual((await names(me.token)).sort(), ['bob', 'carol']);
  await block(me.token, 'bob');
  assert.deepEqual(await names(me.token), ['carol']);
  assert.deepEqual((await names(bob.token)).sort(), ['carol']); // alice is gone for bob as well
  assert.equal((await h.call(bob.token, 'GET', `/readers/${await h.publicId('alice')}`)).statusCode, 404);
  assert.equal((await h.call(me.token, 'GET', `/readers/${await h.publicId('bob')}`)).statusCode, 404);
  await unblock(me.token, 'bob');
  assert.deepEqual((await names(me.token)).sort(), ['bob', 'carol']);
  assert.equal((await h.call(bob.token, 'GET', `/readers/${await h.publicId('alice')}`)).statusCode, 200);
});

h.t('Scenario: The person blocked is not told, and cannot tell who blocked them', async () => {
  const me = await h.reader('alice', { saved: [0] });
  const bob = await h.reader('bob', { saved: [0] });
  await h.reader('carol', { saved: [0] });
  const before = await h.call(bob.token, 'GET', `/readers/${await h.publicId('alice')}`);
  await block(me.token, 'bob');
  const after = await h.call(bob.token, 'GET', `/readers/${await h.publicId('alice')}`);
  assert.equal(after.statusCode, 404);
  assert.equal(after.body, (await h.call(bob.token, 'GET', `/readers/00000000-0000-4000-8000-0000000000ff`)).body); // as for anyone who does not exist
  assert.notEqual(before.statusCode, after.statusCode);
  assert.deepEqual((await list(bob.token)).blocks, []); // the list is only of those I blocked
});

h.t('Scenario: A reader who has since hidden themselves can still be blocked, and stays blocked if they come back', async () => {
  const me = await h.reader('alice', { saved: [0] });
  const bob = await h.reader('bob', { saved: [0] });
  const id = await h.publicId('bob');
  await h.settings(bob.token, { discoverable: false });
  assert.equal((await h.post(me.token, '/me/blocks', { public_id: id })).statusCode, 204);
  await h.settings(bob.token, { discoverable: true });
  assert.deepEqual(await names(me.token), []);
});

h.t('Scenario: Blocks belong to the account that made them', async () => {
  const alice = await h.reader('alice');
  await h.reader('bob');
  const carol = await h.reader('carol');
  await block(alice.token, 'bob');
  assert.deepEqual((await list(carol.token)).blocks, []);
  const again = await h.signIn('alice'); // another phone
  assert.equal((await list(again.token)).blocks.length, 1);
});
