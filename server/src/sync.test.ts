// POST /me/sync: reading list, verified badges and the profile, tied to the account. Merge rules and two phones agreeing.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';

const h = useHarness('sync');
const [A0, A1, A2] = [0, 1, 2].map((n) => () => h.articles[n]);
const profile = (name: string, minutes: number, extra: Record<string, unknown> = {}) => ({ display_name: name, industry: 'Software', interests: ['Cloud', 'Agents'], updated_at: h.at(minutes), ...extra });
const listed = (article: string, minutes: number, removed = false) => ({ article_id: article, saved_at: h.at(minutes), removed, updated_at: h.at(minutes) });
const verified = (article: string, minutes: number, topic = 'Cloud') => ({ article_id: article, verified_at: h.at(minutes), topic });

// ---- who may call it, and what it refuses ---------------------------------------------------------------

h.t('Scenario: Not signed in - 401 for no token and for a made-up one', async () => {
  assert.equal((await h.sync(undefined, 0)).statusCode, 401);
  assert.equal((await h.sync('made-up', 0)).statusCode, 401);
});

h.t('Scenario: Bad input - 400, and nothing in the request is applied, not even the valid part', async () => {
  const { token } = await h.signIn('alice');
  const bad: unknown[] = [
    { cursor: -1, changes: {} },
    { cursor: 1.5, changes: {} },
    { cursor: 'x', changes: {} },
    { cursor: 0, changes: 'no' },
    { cursor: 0, changes: { profile: profile('', 1) } },
    { cursor: 0, changes: { profile: profile('x'.repeat(41), 1) } },
    { cursor: 0, changes: { profile: profile('Ok', 1, { industry: 'Piracy' }) } },
    { cursor: 0, changes: { profile: profile('Ok', 1, { interests: Array.from({ length: 21 }, (_, i) => `t${i}`) }) } },
    { cursor: 0, changes: { profile: profile('Ok', 1, { interests: ['x'.repeat(41)] }) } },
    { cursor: 0, changes: { profile: profile('Ok', 1, { updated_at: 'yesterday' }) } },
    { cursor: 0, changes: { reading_list: [{ article_id: 'nope', saved_at: h.at(1), updated_at: h.at(1) }] } },
    { cursor: 0, changes: { verified: [{ article_id: A0(), verified_at: 'soon', topic: 'Cloud' }] } },
    { cursor: 0, changes: { profile: profile('Fine', 1), reading_list: [listed('00000000-0000-4000-8000-0000000000ff', 1)] } }, // an article that does not exist
  ];
  for (const body of bad) assert.equal((await h.post(token, '/me/sync', body)).statusCode, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await h.rows('SELECT 1 FROM account_reading_list')).length, 0);
  assert.equal((await h.rows('SELECT display_name FROM accounts'))[0].display_name, null);
});

h.t('Scenario: Limits - more changes in one request than allowed, or more saved articles than allowed, is 400', async () => {
  const small = await h.build({ maxChanges: 2, maxReadingList: 2 });
  const { token } = await h.signIn('alice', small);
  assert.equal((await h.sync(token, 0, { reading_list: [listed(A0(), 1), listed(A1(), 1), listed(A2(), 1)] }, small)).statusCode, 400);
  assert.equal((await h.sync(token, 0, { reading_list: [listed(A0(), 1), listed(A1(), 1)] }, small)).statusCode, 200);
  assert.equal((await h.sync(token, 0, { reading_list: [listed(A2(), 2)] }, small)).statusCode, 400); // a third live item
  assert.equal((await h.sync(token, 0, { reading_list: [listed(A0(), 2, true), listed(A2(), 2)] }, small)).statusCode, 200); // one removed, one added: still two
});

// ---- starting, and reading back -------------------------------------------------------------------------

h.t('Scenario: First sync - an empty answer, and the account is marked as syncing from now', async () => {
  const { token } = await h.signIn('alice');
  assert.equal((await h.rows('SELECT sync_started_at FROM accounts'))[0].sync_started_at, null);
  const res = await h.sync(token, 0);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cursor: 0, changes: { profile: null, reading_list: [], verified: [] } });
  assert.deepEqual((await h.rows('SELECT sync_started_at FROM accounts'))[0].sync_started_at, h.clock.now);
  assert.equal(res.headers['cache-control'], 'no-store');
});

h.t('Scenario: A new phone - signing in on a second phone and syncing from nothing gets everything the first one sent', async () => {
  const phone1 = (await h.signIn('alice')).token;
  await h.sync(phone1, 0, { profile: profile('Alice A', 1), reading_list: [listed(A0(), 1)], verified: [verified(A1(), -2)] });
  const phone2 = (await h.signIn('alice')).token;
  const state = await h.pull(phone2);
  assert.deepEqual(state.profile, profile('Alice A', 1));
  assert.deepEqual(state.reading_list, [listed(A0(), 1)]);
  assert.deepEqual(state.verified, [verified(A1(), -2)]);
});

h.t('Scenario: Only what is new - a phone that sends its cursor gets just the changes since', async () => {
  const a = (await h.signIn('alice')).token;
  const b = (await h.signIn('alice')).token;
  const first = (await h.sync(a, 0, { reading_list: [listed(A0(), 1)] })).json();
  assert.ok(first.cursor > 0);
  const caughtUp = (await h.sync(b, 0)).json();
  await h.sync(a, first.cursor, { reading_list: [listed(A1(), 2)] });
  const delta = (await h.sync(b, caughtUp.cursor)).json();
  assert.deepEqual(delta.changes.reading_list.map((i: { article_id: string }) => i.article_id), [A1()]);
  assert.ok(delta.cursor > caughtUp.cursor);
  assert.deepEqual((await h.sync(b, delta.cursor)).json().changes, { profile: null, reading_list: [], verified: [] });
});

h.t('Scenario: Sending the same thing twice - nothing changes, and the cursor does not move', async () => {
  const { token } = await h.signIn('alice');
  const changes = { profile: profile('Alice', 1), reading_list: [listed(A0(), 1)], verified: [verified(A1(), -1)] };
  const once = (await h.sync(token, 0, changes)).json();
  const twice = (await h.sync(token, 0, changes)).json();
  assert.equal(twice.cursor, once.cursor);
  assert.deepEqual(twice.changes, once.changes);
});

// ---- the merge rules -------------------------------------------------------------------------------------

h.t('Scenario: Profile - the newer write wins as a whole, an older one is ignored, and it can be changed again later', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { profile: profile('Second', 10, { industry: 'Finance', interests: ['Safety'] }) });
  await h.sync(token, 0, { profile: profile('First', 5) });
  assert.deepEqual((await h.pull(token)).profile, profile('Second', 10, { industry: 'Finance', interests: ['Safety'] }));
  await h.sync(token, 0, { profile: profile('Third', 20) });
  assert.equal((await h.pull(token)).profile.display_name, 'Third');
});

h.t('Scenario: Reading list - removing leaves a marker so other phones remove it too; a newer save brings it back; an older change is ignored; a tie keeps what is stored', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { reading_list: [listed(A0(), 1)] });
  await h.sync(token, 0, { reading_list: [listed(A0(), 5, true)] });
  assert.deepEqual((await h.pull(token)).reading_list, [listed(A0(), 5, true)]);
  await h.sync(token, 0, { reading_list: [listed(A0(), 3)] }); // older save
  assert.equal((await h.pull(token)).reading_list[0].removed, true);
  await h.sync(token, 0, { reading_list: [{ ...listed(A0(), 5), removed: false }] }); // same time: the stored removal stands
  assert.equal((await h.pull(token)).reading_list[0].removed, true);
  await h.sync(token, 0, { reading_list: [listed(A0(), 8)] });
  assert.equal((await h.pull(token)).reading_list[0].removed, false);
});

h.t('Scenario: Verified badges - only ever added; the earliest time and its topic stand; there is no way to remove one', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { verified: [verified(A0(), -20, 'Safety')] });
  await h.sync(token, 0, { verified: [verified(A0(), -30, 'Cloud')] }); // an earlier verification of the same article
  await h.sync(token, 0, { verified: [verified(A0(), -10, 'Agents')] }); // a later one changes nothing
  assert.deepEqual((await h.pull(token)).verified, [verified(A0(), -30, 'Cloud')]);
  const odd = await h.sync(token, 0, { verified: [{ ...verified(A0(), -5), removed: true }] }); // there is no such thing as unverifying
  assert.equal(odd.statusCode === 200 || odd.statusCode === 400, true);
  assert.equal((await h.pull(token)).verified.length, 1);
});

h.t('Scenario: A phone whose clock is far ahead - the verification counts from the server\'s time, as on the leaderboard today', async () => {
  const { token } = await h.signIn('alice');
  await h.sync(token, 0, { verified: [verified(A0(), 60)] }); // an hour ahead
  assert.equal((await h.pull(token)).verified[0].verified_at, h.clock.now.toISOString());
  await h.sync(token, 0, { verified: [verified(A1(), 4)] }); // within 5 minutes: believed
  assert.equal((await h.pull(token)).verified.find((v: { article_id: string }) => v.article_id === A1()).verified_at, h.at(4));
});

// ---- two phones, any order -------------------------------------------------------------------------------

h.t('Scenario: Two phones that disagree end up the same, whichever reaches the server first', async () => {
  const fromPhoneA = { profile: profile('A name', 1), reading_list: [listed(A0(), 1), listed(A1(), 3, true), listed(A2(), 1)], verified: [verified(A0(), -9, 'Cloud')] };
  const fromPhoneB = { profile: profile('B name', 2, { industry: 'Media' }), reading_list: [listed(A0(), 2, true), listed(A1(), 2)], verified: [verified(A0(), -8, 'Safety'), verified(A1(), -5)] };
  const results = [];
  for (const [user, order] of [['alice', ['A', 'B']], ['bob', ['B', 'A']]] as const) {
    const a = (await h.signIn(user)).token;
    const b = (await h.signIn(user)).token;
    for (const who of order) await h.sync(who === 'A' ? a : b, 0, who === 'A' ? fromPhoneA : fromPhoneB);
    const [seenByA, seenByB] = [await h.pull(a), await h.pull(b)];
    assert.deepEqual(seenByA, seenByB);
    results.push(seenByA);
  }
  assert.deepEqual(results[0], results[1]);
  // The newer edit of each thing won: B's profile; A0 removed by B (later than A's save); A1 removed by A (later than B's save); A2 saved; the earliest verification of A0 (phone A's, with its topic).
  assert.equal(results[0].profile.display_name, 'B name');
  assert.deepEqual(results[0].reading_list.map((i: { article_id: string; removed: boolean }) => [i.article_id, i.removed]), [[A0(), true], [A1(), true], [A2(), false]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
  assert.deepEqual(results[0].verified, [verified(A0(), -9, 'Cloud'), verified(A1(), -5)].sort((x, y) => x.article_id.localeCompare(y.article_id)));
});

h.t('Scenario: Accounts are separate - one reader never sees another\'s data', async () => {
  const alice = (await h.signIn('alice')).token;
  const bob = (await h.signIn('bob')).token;
  await h.sync(alice, 0, { profile: profile('Alice', 1), reading_list: [listed(A0(), 1)], verified: [verified(A1(), 1)] });
  assert.deepEqual(await h.pull(bob), { profile: null, reading_list: [], verified: [] });
});
