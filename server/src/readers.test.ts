// "Also reading": the readers of an article, and a reader's card. Real people who chose to be seen, nothing else about anyone.
import assert from 'node:assert/strict';
import { useHarness, USERS, type UserKey } from '../testkit/harness.ts';

const h = useHarness('readers');
const [A0, A1, A2] = [0, 1, 2].map((n) => () => h.articles[n]);
const DAY = 24 * 60;
const FIELDS = ['action', 'can_message', 'display_name', 'industry', 'interests', 'public_id', 'shared_interests'];
const readers = (token: string | undefined, article: string, app = h.app) => h.call(token, 'GET', `/articles/${article}/readers`, undefined, app);
const names = (res: { json(): { readers: Array<{ display_name: string }> } }) => res.json().readers.map((r) => r.display_name);
const block = async (token: string, user: UserKey) => assert.equal((await h.post(token, '/me/blocks', { public_id: await h.publicId(user) })).statusCode, 204);

// ---- the list ---------------------------------------------------------------------------------------

h.t('Scenario: Only a reader who is visible themselves may look - reciprocity', async () => {
  const { token } = await h.signIn('alice');
  const res = await readers(token, A0());
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'visibility_required');
  await h.reader('alice', { visible: false });
  assert.equal((await readers(token, A0())).statusCode, 403); // a profile alone is not enough
});

h.t('Scenario: Not signed in - 401; an article that does not exist - 404', async () => {
  assert.equal((await readers(undefined, A0())).statusCode, 401);
  assert.equal((await readers('made-up', A0())).statusCode, 401);
  const me = await h.reader('alice');
  assert.equal((await readers(me.token, '00000000-0000-4000-8000-0000000000ff')).statusCode, 404);
  assert.equal((await readers(me.token, 'not-an-id')).statusCode, 404);
});

h.t('Scenario: Readers of the article who chose to be seen are listed, with saved or verified', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0] });
  await h.reader('carol', { verified: [0] });
  await h.reader('dave', { saved: [1] }); // a different article
  await h.reader('erin', { saved: [0], visible: false }); // did not opt in
  await h.reader('frank', { saved: [0], verified: [0] }); // both: shown as verified
  const res = await readers(me.token, A0());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(names(res).sort(), ['bob', 'carol', 'frank']);
  const action = (n: string) => res.json().readers.find((r: { display_name: string }) => r.display_name === n).action;
  assert.deepEqual([action('bob'), action('carol'), action('frank')], ['saved', 'verified', 'verified']);
  assert.equal(res.headers['cache-control'], 'no-store');
});

h.t('Scenario: A removed save, or an action more than 30 days old, does not count', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [{ article: 0, removed: true }] });
  await h.reader('carol', { saved: [{ article: 0, minutesAgo: 40 * DAY }] });
  await h.reader('dave', { verified: [{ article: 0, minutesAgo: 31 * DAY }] });
  await h.reader('erin', { saved: [{ article: 0, minutesAgo: 29 * DAY }] }); // inside the window
  assert.deepEqual(names(await readers(me.token, A0())), ['erin']);
});

h.t('Scenario: You are never in your own list', async () => {
  const me = await h.reader('alice', { saved: [0] });
  await h.reader('bob', { saved: [0] });
  assert.deepEqual(names(await readers(me.token, A0())), ['bob']);
});

h.t('Scenario: Nobody you blocked, nobody who blocked you, nobody suspended', async () => {
  const me = await h.reader('alice');
  const bob = await h.reader('bob', { saved: [0] });
  const carol = await h.reader('carol', { saved: [0] });
  await h.reader('dave', { saved: [0] });
  await h.reader('erin', { saved: [0] });
  await block(me.token, 'bob');
  assert.equal((await h.post(carol.token, '/me/blocks', { public_id: await h.publicId('alice') })).statusCode, 204);
  await h.rows(`UPDATE accounts SET suspended_until = $1 WHERE email = $2`, [new Date(h.clock.now.getTime() + 86_400_000), USERS.dave.email]);
  assert.deepEqual(names(await readers(me.token, A0())), ['erin']);
  assert.deepEqual(names(await readers(bob.token, A0())).sort(), ['carol', 'erin']); // bob is hidden from alice, not from the others; dave is suspended
});

h.t('Scenario: At most 5, the ones with most in common first, then the most recent', async () => {
  const me = await h.reader('alice', { interests: ['Cloud', 'Agents', 'Safety'] });
  await h.reader('bob', { saved: [{ article: 0, minutesAgo: 100 }], interests: ['Cloud', 'Agents', 'Safety', 'Research'] });
  await h.reader('carol', { saved: [{ article: 0, minutesAgo: 50 }], interests: ['Cloud', 'Agents'] });
  await h.reader('dave', { saved: [{ article: 0, minutesAgo: 10 }], interests: ['Agents', 'Safety'] });
  await h.reader('erin', { saved: [{ article: 0, minutesAgo: 5 }], interests: ['Cloud', 'Open source'] });
  await h.reader('frank', { saved: [{ article: 0, minutesAgo: 1 }], interests: ['Research'] });
  await h.reader('grace', { saved: [{ article: 0, minutesAgo: 2 }], interests: ['Research'] });
  await h.reader('heidi', { saved: [{ article: 0, minutesAgo: 3 }], interests: ['Research'] });
  const res = await readers(me.token, A0());
  const list = res.json().readers;
  assert.deepEqual(list.map((r: { display_name: string; shared_interests: number }) => [r.display_name, r.shared_interests]), [['bob', 3], ['dave', 2], ['carol', 2], ['erin', 1], ['frank', 0]]);
  assert.equal(res.json().count, 7); // the count is of everyone, not of the five shown
});

h.t('Scenario: Exactly these fields and nothing private - no email, Google id, account id, reference code or device number', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0], interests: ['Cloud', 'Agents'], industry: 'Finance', accepts: true });
  await h.post(undefined, '/verifications', { device_id: h.device(1), display_name: 'Old', article_id: A0(), verified_at: h.at(-30) });
  const res = await readers(me.token, A0());
  const [one] = res.json().readers;
  assert.deepEqual(Object.keys(one).sort(), FIELDS);
  assert.deepEqual({ name: one.display_name, industry: one.industry, interests: one.interests }, { name: 'bob', industry: 'Finance', interests: ['Cloud', 'Agents'] });
  const [account] = await h.rows(`SELECT id, ref FROM accounts WHERE email = $1`, [USERS.bob.email]);
  for (const secret of [USERS.bob.email, USERS.bob.sub, account.id, account.ref, h.device(1), me.ref, USERS.alice.email]) assert.ok(!res.body.includes(secret), secret);
  assert.equal(one.public_id, await h.publicId('bob'));
});

h.t('Scenario: A reader says whether they take messages', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0], accepts: true });
  await h.reader('carol', { saved: [0], accepts: false });
  const list = (await readers(me.token, A0())).json().readers;
  const can = (n: string) => list.find((r: { display_name: string }) => r.display_name === n).can_message;
  assert.deepEqual([can('bob'), can('carol')], [true, false]);
});

h.t('Scenario: Changes show at once - hiding yourself, taking the article off your list, a message setting', async () => {
  const me = await h.reader('alice');
  const bob = await h.reader('bob', { saved: [0] });
  const carol = await h.reader('carol', { saved: [0] });
  assert.deepEqual(names(await readers(me.token, A0())).sort(), ['bob', 'carol']);
  await h.settings(bob.token, { discoverable: false });
  assert.deepEqual(names(await readers(me.token, A0())), ['carol']);
  await h.sync(carol.token, 0, { reading_list: [{ article_id: A0(), saved_at: h.at(-5), removed: true, updated_at: h.at(1) }] });
  assert.deepEqual(names(await readers(me.token, A0())), []);
});

h.t('Scenario: The public id is stable, and different for each reader', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0] });
  await h.reader('carol', { saved: [0] });
  const first = (await readers(me.token, A0())).json().readers.map((r: { public_id: string }) => r.public_id).sort();
  const second = (await readers(me.token, A0())).json().readers.map((r: { public_id: string }) => r.public_id).sort();
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2);
  assert.deepEqual(first, [await h.publicId('bob'), await h.publicId('carol')].sort());
});

h.t('Scenario: The count is real, includes readers who are not visible, and is hidden below 3', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [1] });
  await h.reader('carol', { verified: [1], visible: false });
  let res = await readers(me.token, A1());
  assert.equal(res.json().count, 0); // two readers: too few to say
  assert.equal(res.json().readers.length, 1);
  await h.reader('dave', { saved: [1], verified: [1] }); // saved and verified: counts once
  res = await readers(me.token, A1());
  assert.equal(res.json().count, 3);
  assert.equal(res.json().readers.length, 2); // the one who is hidden is counted but not shown
});

h.t('Scenario: Too many looks - 429', async () => {
  const me = await h.reader('alice');
  const small = await h.build({ readersPerHour: 2 });
  assert.equal((await readers(me.token, A0(), small)).statusCode, 200);
  assert.equal((await readers(me.token, A0(), small)).statusCode, 200);
  assert.equal((await readers(me.token, A0(), small)).statusCode, 429);
});

// ---- a reader's card --------------------------------------------------------------------------------

const card = (token: string | undefined, publicId: string) => h.call(token, 'GET', `/readers/${publicId}`);

h.t('Scenario: A visible reader\'s card - name, industry, interests, how many articles they verified, whether they take messages', async () => {
  const me = await h.reader('alice');
  await h.reader('bob', { saved: [0], verified: [0, 1], industry: 'Healthcare', interests: ['Safety'], accepts: true });
  const res = await card(me.token, await h.publicId('bob'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json()).sort(), ['can_message', 'display_name', 'industry', 'interests', 'public_id', 'verified_count']);
  assert.deepEqual(res.json(), { public_id: await h.publicId('bob'), display_name: 'bob', industry: 'Healthcare', interests: ['Safety'], verified_count: 2, can_message: true });
  assert.equal(res.headers['cache-control'], 'no-store');
  for (const secret of [USERS.bob.email, USERS.bob.sub]) assert.ok(!res.body.includes(secret));
});

h.t('Scenario: Looking at a card needs you to be visible too, and to be signed in', async () => {
  await h.reader('bob', { saved: [0] });
  const hidden = await h.reader('alice', { visible: false });
  assert.equal((await card(hidden.token, await h.publicId('bob'))).statusCode, 403);
  assert.equal((await card(undefined, await h.publicId('bob'))).statusCode, 401);
});

h.t('Scenario: A card that cannot be shown is "not found", the same whatever the reason', async () => {
  const me = await h.reader('alice');
  const bob = await h.reader('bob');
  await h.reader('carol');
  await h.reader('dave', { visible: false });
  await h.reader('erin');
  await h.reader('frank');
  await block(me.token, 'carol'); // I blocked her
  await h.post(bob.token, '/me/blocks', { public_id: await h.publicId('alice') }); // he blocked me
  await h.rows(`UPDATE accounts SET suspended_until = $1 WHERE email = $2`, [new Date(h.clock.now.getTime() + 86_400_000), USERS.erin.email]);
  const answers = [
    await card(me.token, await h.publicId('bob')), // blocked me
    await card(me.token, await h.publicId('carol')), // blocked by me
    await card(me.token, await h.publicId('dave')), // not visible
    await card(me.token, await h.publicId('erin')), // suspended
    await card(me.token, await h.publicId('alice')), // myself
    await card(me.token, '00000000-0000-4000-8000-0000000000ff'), // nobody
    await card(me.token, 'not-an-id'),
  ];
  for (const a of answers) assert.equal(a.statusCode, 404);
  assert.equal(new Set(answers.map((a) => a.body)).size, 1); // not one of them can be told apart
  assert.equal((await card(me.token, await h.publicId('frank'))).statusCode, 200);
});
