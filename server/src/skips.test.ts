// Skip counts: tied to the account and counted from sign-in, whether or not syncing has started.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';

const h = useHarness('skips');
const [A0, A1, A2] = [0, 1, 2].map((n) => () => h.articles[n]);
const skips = (token: string | undefined, article_ids: unknown, app = h.app) => h.post(token, '/me/skips', { article_ids }, app);
const counts = async (email: string) =>
  Object.fromEntries((await h.rows('SELECT s.article_id, s.skips FROM account_skips s JOIN accounts a ON a.id = s.account_id WHERE a.email = $1', [email])).map((r) => [r.article_id, r.skips]));

h.t('Scenario: Counted from sign-in - skips are stored per account and article without any sync, and syncing is not started by them', async () => {
  const { token } = await h.signIn('alice');
  const res = await skips(token, [A0(), A0(), A1()]);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(await counts('alice@example.com'), { [A0()]: 2, [A1()]: 1 });
  assert.equal((await h.rows('SELECT sync_started_at FROM accounts'))[0].sync_started_at, null);
});

h.t('Scenario: Counts add up across requests and across the account\'s phones', async () => {
  const phone1 = (await h.signIn('alice')).token;
  const phone2 = (await h.signIn('alice')).token;
  await skips(phone1, [A0()]);
  await skips(phone2, [A0(), A2()]);
  assert.deepEqual(await counts('alice@example.com'), { [A0()]: 2, [A2()]: 1 });
});

h.t('Scenario: Each account has its own counts', async () => {
  const alice = (await h.signIn('alice')).token;
  const bob = (await h.signIn('bob')).token;
  await skips(alice, [A0()]);
  await skips(bob, [A0(), A0(), A0()]);
  assert.deepEqual(await counts('alice@example.com'), { [A0()]: 1 });
  assert.deepEqual(await counts('bob@example.com'), { [A0()]: 3 });
});

h.t('Scenario: Not signed in - 401, nothing counted', async () => {
  assert.equal((await skips(undefined, [A0()])).statusCode, 401);
  assert.equal((await skips('made-up', [A0()])).statusCode, 401);
  assert.equal((await h.rows('SELECT 1 FROM account_skips')).length, 0);
});

h.t('Scenario: Bad input - 400 and nothing from that request is counted', async () => {
  const { token } = await h.signIn('alice');
  const bad: unknown[] = [[], 'x', null, [A0(), 'nope'], [A0(), '00000000-0000-4000-8000-0000000000ff'], Array.from({ length: 101 }, () => A0())];
  for (const ids of bad) assert.equal((await skips(token, ids)).statusCode, 400, JSON.stringify(ids).slice(0, 60));
  assert.equal((await h.post(token, '/me/skips', {})).statusCode, 400);
  assert.equal((await h.rows('SELECT 1 FROM account_skips')).length, 0);
  assert.equal((await skips(token, Array.from({ length: 100 }, () => A0()))).statusCode, 204); // 100 is allowed
});

h.t('Scenario: Too many requests - 429 for the account, not for another', async () => {
  const small = await h.build({ skipsPerHour: 2 });
  const alice = (await h.signIn('alice', small)).token;
  const bob = (await h.signIn('bob', small)).token;
  assert.equal((await skips(alice, [A0()], small)).statusCode, 204);
  assert.equal((await skips(alice, [A0()], small)).statusCode, 204);
  assert.equal((await skips(alice, [A0()], small)).statusCode, 429);
  assert.equal((await skips(bob, [A0()], small)).statusCode, 204);
});

h.t('Scenario: What is kept - only account, article and a number: no time, no device, no session', async () => {
  const cols = await h.rows(`SELECT column_name FROM information_schema.columns WHERE table_name = 'account_skips' AND table_schema = current_schema() ORDER BY column_name`);
  assert.deepEqual(cols.map((c) => c.column_name), ['account_id', 'article_id', 'skips']);
});

h.t('Scenario: Skips are never sent back to anyone - not on the board, not in a sync', async () => {
  const { token } = await h.signIn('alice');
  await skips(token, [A0()]);
  await h.sync(token, 0, { verified: [{ article_id: A1(), verified_at: h.at(-5), topic: 'Cloud' }] });
  assert.ok(!JSON.stringify(await h.pull(token)).includes(A0()));
  assert.ok(!(await h.call(token, 'GET', '/leaderboard')).body.includes(A0()));
});
