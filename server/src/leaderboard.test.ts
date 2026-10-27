// Runs the real SQL against PostgreSQL, in a throwaway schema that is dropped afterwards.
// Skipped when no database is reachable (for example without DATABASE_URL).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createArticleStore, type NewArticle } from './db.ts';
import { clampVerifiedAt, createLeaderboardStore, LEADERBOARD_SIZE, MAX_CLOCK_AHEAD_MS, type LeaderboardStore } from './leaderboard.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `lb_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let store: LeaderboardStore;
let skip: string | false = false;

before(async () => {
  const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch {
    skip = 'no database reachable';
    await admin.end();
    return;
  }
  await admin.end();
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  store = createLeaderboardStore(pool);
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const newArticle = (n: number): NewArticle => ({
  source_company: 'Google',
  source_url: `https://blog.google/innovation-and-ai/lb-${n}`,
  content_type: 'Release',
  title: `Post ${n}`,
  summary: words(55),
  published_at: '2026-09-01T00:00:00.000Z',
  fetched_at: '2026-10-04T12:00:00.000Z',
  reader_count: 0,
});
const device = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const articleIds: string[] = [];
/** Makes sure at least `n` articles exist and returns their ids. */
async function articles(n: number) {
  const articleStore = createArticleStore(pool!);
  while (articleIds.length < n) {
    const next = articleIds.length + 1;
    await articleStore.insert(newArticle(next));
    articleIds.push((await pool!.query('SELECT id FROM articles WHERE source_url = $1', [newArticle(next).source_url])).rows[0].id);
  }
  return articleIds.slice(0, n);
}
const reset = () => pool!.query('TRUNCATE verifications, players');
/** `device n` verifies the first `count` articles, one every minute from `start`. */
async function verifyMany(n: number, name: string, count: number, startMinutes: number) {
  const ids = await articles(count);
  for (const [i, id] of ids.entries()) await store.record({ device_id: device(n), display_name: name, article_id: id, verified_at: at(startMinutes + i) }, NOW);
}

test('Scenario: Idempotent insert - the same device and article sent twice counts once', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  const v = { device_id: device(1), display_name: 'Maya', article_id: id, verified_at: at(-10) };
  assert.equal(await store.record(v, NOW), true);
  assert.equal(await store.record(v, NOW), false);
  assert.equal(await store.record(v, NOW), false);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM verifications')).rows[0].n, 1);
  assert.deepEqual((await store.leaderboard()).rows, [{ rank: 1, display_name: 'Maya', count: 1, is_you: false }]);
});

test('the same verification sent twice at the same moment is also stored once, without an error', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  const v = { device_id: device(1), display_name: 'Maya', article_id: id, verified_at: at(-10) };
  const results = await Promise.all([store.record(v, NOW), store.record(v, NOW), store.record(v, NOW)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM verifications')).rows[0].n, 1);
});

test('a repeat keeps the first verification time, so the tie-break cannot be changed by sending it again', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  await store.record({ device_id: device(1), display_name: 'Maya', article_id: id, verified_at: at(-30) }, NOW);
  await store.record({ device_id: device(1), display_name: 'Maya', article_id: id, verified_at: at(-1) }, NOW);
  const { rows } = await pool!.query('SELECT verified_at FROM verifications');
  assert.equal(rows[0].verified_at.toISOString(), at(-30));
});

test('Scenario: Appear on the board - three verified articles show the name with 3', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Maya Chen', 3, -100);
  assert.deepEqual(await store.leaderboard(), { rows: [{ rank: 1, display_name: 'Maya Chen', count: 3, is_you: false }], you: null });
});

test('Scenario: Ranking and ties - 8, 5 and 5 gives the 8, then the 5 reached first, then the 5 reached later', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Early five', 5, -500); // reached 5 at -496
  await verifyMany(2, 'Eight', 8, -300);
  await verifyMany(3, 'Late five', 5, -200); // reached 5 at -196
  const { rows } = await store.leaderboard();
  assert.deepEqual(rows.map((r) => [r.rank, r.display_name, r.count]), [[1, 'Eight', 8], [2, 'Early five', 5], [3, 'Late five', 5]]);
});

test('the tie-break looks at when the count was reached, not when the player first started', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Started first, finished last', 2, -500);
  await store.record({ device_id: device(1), display_name: 'Started first, finished last', article_id: (await articles(3))[2], verified_at: at(-1) }, NOW); // a third, much later
  await verifyMany(2, 'Started later, finished first', 3, -100); // reaches 3 at -98
  const { rows } = await store.leaderboard();
  assert.deepEqual(rows.map((r) => r.display_name), ['Started later, finished first', 'Started first, finished last']);
});

test('exact ties on count and time are settled by device id, the same way every time', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  for (const n of [3, 1, 2]) await store.record({ device_id: device(n), display_name: `P${n}`, article_id: id, verified_at: at(-10) }, NOW);
  for (let i = 0; i < 3; i++) assert.deepEqual((await store.leaderboard()).rows.map((r) => [r.rank, r.display_name]), [[1, 'P1'], [2, 'P2'], [3, 'P3']]); // three different ranks, never a shared one
});

test('Scenario: Own rank beyond 50 - 60 players, the caller 57th: the top 50 and the caller\'s true rank', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  for (let n = 1; n <= 60; n++) await store.record({ device_id: device(n), display_name: `P${n}`, article_id: id, verified_at: at(-1000 + n) }, NOW); // all have 1, so earlier is better
  const result = await store.leaderboard(device(57));
  assert.equal(LEADERBOARD_SIZE, 50);
  assert.equal(result.rows.length, 50);
  assert.deepEqual(result.rows.map((r) => r.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.ok(result.rows.every((r) => r.is_you === false)); // the caller is not among them
  assert.deepEqual(result.you, { rank: 57, display_name: 'P57', count: 1, is_you: true });
});

test('a caller inside the top 50 is flagged in the rows and also returned as you', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Maya', 2, -100);
  await verifyMany(2, 'Daniel', 1, -100);
  const result = await store.leaderboard(device(2));
  assert.deepEqual(result.rows.map((r) => [r.display_name, r.is_you]), [['Maya', false], ['Daniel', true]]);
  assert.deepEqual(result.you, { rank: 2, display_name: 'Daniel', count: 1, is_you: true });
});

test('a caller who has not verified anything, an unknown device, or no device id gets no "you"', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Maya', 1, -100);
  await pool!.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, 'Lurker', now())`, [device(9)]);
  assert.equal((await store.leaderboard(device(9))).you, null); // known, but zero verifications
  assert.equal((await store.leaderboard(device(8))).you, null); // never seen
  assert.equal((await store.leaderboard()).you, null);
});

test('players with no verification are not listed', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Maya', 1, -100);
  await pool!.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, 'Lurker', now())`, [device(9)]);
  assert.deepEqual((await store.leaderboard()).rows.map((r) => r.display_name), ['Maya']);
});

test('Scenario: Empty board - nobody has verified anything', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  assert.deepEqual(await store.leaderboard(device(1)), { rows: [], you: null });
});

test('the number of rows follows the limit asked for', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  for (let n = 1; n <= 10; n++) await store.record({ device_id: device(n), display_name: `P${n}`, article_id: id, verified_at: at(-100 + n) }, NOW);
  assert.equal((await store.leaderboard(undefined, 3)).rows.length, 3);
  const beyond = await store.leaderboard(device(7), 3);
  assert.equal(beyond.rows.length, 3);
  assert.equal(beyond.you?.rank, 7);
});

test('Scenario: Name changes - a later post with a new name renames the player without losing their count', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Old name', 2, -100);
  const [, , third] = await articles(3);
  await store.record({ device_id: device(1), display_name: 'New name', article_id: third, verified_at: at(-5) }, NOW);
  assert.deepEqual((await store.leaderboard()).rows, [{ rank: 1, display_name: 'New name', count: 3, is_you: false }]);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 1);
});

test('even a repeat of an old verification carries the current name', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  await store.record({ device_id: device(1), display_name: 'Old name', article_id: id, verified_at: at(-10) }, NOW);
  assert.equal(await store.record({ device_id: device(1), display_name: 'New name', article_id: id, verified_at: at(-10) }, NOW), false);
  assert.equal((await store.leaderboard()).rows[0].display_name, 'New name');
});

test('Scenario: Unknown article - nothing is stored, not even the player', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await assert.rejects(store.record({ device_id: device(1), display_name: 'Maya', article_id: '00000000-0000-4000-8000-0000000000ff', verified_at: at(-1) }, NOW), /verifications_article_id_fkey/);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 0);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM verifications')).rows[0].n, 0);
  // and the connection pool still works afterwards
  const [id] = await articles(1);
  assert.equal(await store.record({ device_id: device(1), display_name: 'Maya', article_id: id, verified_at: at(-1) }, NOW), true);
});

test('Scenario: No personal data - the response has only rank, name, count and the caller flag', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await verifyMany(1, 'Maya', 2, -100);
  await verifyMany(2, 'Daniel', 1, -100);
  const result = await store.leaderboard(device(1));
  for (const row of [...result.rows, result.you!]) assert.deepEqual(Object.keys(row).sort(), ['count', 'display_name', 'is_you', 'rank']);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(device(1)) && !text.includes(device(2)), 'no device id');
  assert.ok(!/article|verified_at|updated_at/i.test(text), 'no reading history or times');
  for (const row of result.rows) assert.equal(typeof row.count, 'number');
  for (const row of result.rows) assert.equal(typeof row.rank, 'number');
});

test('a verification time far in the future is replaced by the server time before it is stored', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  await store.record({ device_id: device(1), display_name: 'Clock ahead', article_id: id, verified_at: at(60 * 24 * 365) }, NOW);
  const { rows } = await pool!.query('SELECT verified_at FROM verifications');
  assert.equal(rows[0].verified_at.toISOString(), NOW.toISOString());
});

test('a record with a verified_at that is not a date is refused before it reaches the database', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const [id] = await articles(1);
  await assert.rejects(store.record({ device_id: device(1), display_name: 'Maya', article_id: id, verified_at: 'yesterday-ish' }, NOW), /not a date/);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 0);
});

test('clampVerifiedAt keeps past times and times up to 5 minutes ahead, and replaces anything further ahead', () => {
  assert.equal(MAX_CLOCK_AHEAD_MS, 5 * 60_000);
  assert.equal(clampVerifiedAt(at(-60 * 24 * 30), NOW).toISOString(), at(-60 * 24 * 30)); // a month ago: an offline queue
  assert.equal(clampVerifiedAt(NOW.toISOString(), NOW).toISOString(), NOW.toISOString());
  assert.equal(clampVerifiedAt(at(4), NOW).toISOString(), at(4));
  assert.equal(clampVerifiedAt(at(5), NOW).toISOString(), at(5)); // exactly 5 minutes ahead is still believed
  assert.equal(clampVerifiedAt(at(5.001), NOW), NOW); // a little more is not
  assert.equal(clampVerifiedAt('2099-01-01T00:00:00Z', NOW), NOW);
});

test('clampVerifiedAt throws on text that is not a date', () => {
  for (const bad of ['', 'not a date', '2026-13-45T99:99:99Z']) assert.throws(() => clampVerifiedAt(bad, NOW), /not a date/, bad);
});
