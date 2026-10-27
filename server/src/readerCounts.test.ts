// "N reading" is counted from real activity: distinct accounts that saved or verified the article in the last 30 days, hidden or not,
// and only said when it is 3 or more. The random number the pipeline used to store is ignored.
import assert from 'node:assert/strict';
import { useHarness } from '../testkit/harness.ts';

const h = useHarness('rcount');
const [A0, A1] = [0, 1].map((n) => () => h.articles[n]);
const DAY = 24 * 60;
const count = async (article: string) => (await h.app.inject({ method: 'GET', url: `/articles/${article}` })).json().reader_count;
const feedCounts = async () => Object.fromEntries(((await h.app.inject({ method: 'GET', url: '/feed?limit=10' })).json() as Array<{ id: string; reader_count: number }>).map((a) => [a.id, a.reader_count]));

h.t('Scenario: The number stored with the article is ignored - with no readers it is 0', async () => {
  await h.rows('UPDATE articles SET reader_count = 250');
  assert.equal(await count(A0()), 0);
  assert.equal((await feedCounts())[A0()], 0);
});

h.t('Scenario: Distinct accounts that saved or verified it - each counted once, visible or not', async () => {
  await h.reader('alice', { saved: [0] });
  await h.reader('bob', { verified: [0] });
  await h.reader('carol', { saved: [0], verified: [0] }); // both: once
  await h.reader('dave', { saved: [0], visible: false }); // not visible, still counted: it is a number, not a person
  assert.equal(await count(A0()), 4);
});

h.t('Scenario: A removed save and an action more than 30 days old do not count', async () => {
  await h.reader('alice', { saved: [0] });
  await h.reader('bob', { saved: [0] });
  await h.reader('carol', { saved: [0] });
  await h.reader('dave', { saved: [{ article: 0, removed: true }] });
  await h.reader('erin', { saved: [{ article: 0, minutesAgo: 40 * DAY }] });
  await h.reader('frank', { verified: [{ article: 0, minutesAgo: 31 * DAY }] });
  assert.equal(await count(A0()), 3);
});

h.t('Scenario: Fewer than 3 is not said at all - 0, so nobody can be picked out from a tiny number', async () => {
  await h.reader('alice', { saved: [0] });
  await h.reader('bob', { saved: [0] });
  assert.equal(await count(A0()), 0);
  await h.reader('carol', { verified: [0] });
  assert.equal(await count(A0()), 3);
});

h.t('Scenario: The window moves with the clock', async () => {
  for (const u of ['alice', 'bob', 'carol'] as const) await h.reader(u, { saved: [0] });
  assert.equal(await count(A0()), 3);
  h.clock.now = new Date(h.clock.now.getTime() + 31 * DAY * 60_000);
  assert.equal(await count(A0()), 0);
});

h.t('Scenario: The feed and the article page agree, article by article', async () => {
  for (const u of ['alice', 'bob', 'carol'] as const) await h.reader(u, { saved: [0] });
  for (const u of ['dave', 'erin', 'frank', 'grace'] as const) await h.reader(u, { verified: [1] });
  const feed = await feedCounts();
  assert.equal(feed[A0()], 3);
  assert.equal(feed[A1()], 4);
  assert.equal(feed[A0()], await count(A0()));
  assert.equal(feed[A1()], await count(A1()));
  assert.equal(typeof feed[h.articles[2]], 'number');
});
