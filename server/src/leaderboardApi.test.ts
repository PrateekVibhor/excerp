// The leaderboard through the real API and the real SQL, in a throwaway schema. Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { buildApi } from './api.ts';
import { createArticleReader, createArticleStore } from './db.ts';
import { createLeaderboardStore } from './leaderboard.ts';
import { createRateLimiter } from './rateLimit.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `lbapi_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let skip: string | false = false;
let app: Awaited<ReturnType<typeof buildApi>>;
const ids: string[] = [];

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
  const store = createArticleStore(pool);
  for (let n = 1; n <= 3; n++) {
    await store.insert({
      source_company: 'Google', source_url: `https://blog.google/lbapi-${n}`, content_type: 'Release', title: `Post ${n}`,
      summary: Array.from({ length: 55 }, (_, i) => `w${i}`).join(' '), published_at: '2026-09-01T00:00:00.000Z', fetched_at: '2026-10-04T12:00:00.000Z', reader_count: 0,
    });
    ids.push((await pool.query('SELECT id FROM articles WHERE source_url = $1', [`https://blog.google/lbapi-${n}`])).rows[0].id);
  }
  // All the tests post from one address, so the per-address limit (tested in routes.test.ts) is set out of the way here.
  app = await buildApi({ ping: async () => {}, articles: createArticleReader(pool), leaderboard: createLeaderboardStore(pool), ipLimiter: createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }) });
});

after(async () => {
  if (!pool) return;
  await app.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const device = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const send = (n: number, article: number, name = `Reader ${n}`, minutesAgo = 10) =>
  app.inject({ method: 'POST', url: '/verifications', payload: { device_id: device(n), display_name: name, article_id: ids[article], verified_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() } });
const board = async (n?: number) => (await app.inject({ method: 'GET', url: n ? `/leaderboard?device_id=${device(n)}` : '/leaderboard' })).json();
const count = async (table: string) => (await pool!.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const reset = () => pool!.query('TRUNCATE verifications, players');

test('Scenario: Empty board - "No verified readers yet" starts as an empty list', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  assert.deepEqual(await board(), { rows: [], you: null });
});

test('Scenario: Appear on the board - a verification shows the name with 1, and 3 articles show 3', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  assert.equal((await send(1, 0, 'Maya Chen')).statusCode, 204);
  assert.deepEqual((await board()).rows, [{ rank: 1, display_name: 'Maya Chen', count: 1, is_you: false }]);
  await send(1, 1, 'Maya Chen');
  await send(1, 2, 'Maya Chen');
  assert.deepEqual((await board()).rows, [{ rank: 1, display_name: 'Maya Chen', count: 3, is_you: false }]);
});

test('Scenario: No double counting - the same verification sent twice counts once, and both answers are 204', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  assert.equal((await send(1, 0)).statusCode, 204);
  assert.equal((await send(1, 0)).statusCode, 204);
  assert.equal(await count('verifications'), 1);
  assert.equal((await board()).rows[0].count, 1);
});

test('Scenario: Ranking and ties over HTTP - 3, 2 and 2 verified, the second 2 reached later', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  for (const [article, minutes] of [[0, 300], [1, 299], [2, 298]] as const) await send(1, article, 'Three', minutes);
  for (const [article, minutes] of [[0, 200], [1, 199]] as const) await send(2, article, 'Early two', minutes);
  for (const [article, minutes] of [[0, 100], [1, 99]] as const) await send(3, article, 'Late two', minutes);
  assert.deepEqual((await board()).rows.map((r: { rank: number; display_name: string; count: number }) => [r.rank, r.display_name, r.count]), [[1, 'Three', 3], [2, 'Early two', 2], [3, 'Late two', 2]]);
});

test('Scenario: Own position - the caller is flagged, and "you" carries the rank', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await send(1, 0);
  await send(1, 1);
  await send(2, 0);
  const result = await board(2);
  assert.deepEqual(result.rows.map((r: { is_you: boolean }) => r.is_you), [false, true]);
  assert.deepEqual(result.you, { rank: 2, display_name: 'Reader 2', count: 1, is_you: true });
});

test('Scenario: Own rank beyond 50 over HTTP - 60 players, the caller 57th', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  for (let n = 1; n <= 60; n++) assert.equal((await send(n, 0, `P${n}`, 1000 - n)).statusCode, 204);
  const result = await board(57);
  assert.equal(result.rows.length, 50);
  assert.deepEqual(result.rows.map((r: { rank: number }) => r.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.deepEqual(result.you, { rank: 57, display_name: 'P57', count: 1, is_you: true });
});

test('Scenario: Unknown article - 400, and not even the player is stored', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const res = await app.inject({ method: 'POST', url: '/verifications', payload: { device_id: device(1), display_name: 'Maya', article_id: '00000000-0000-4000-8000-0000000000ff', verified_at: new Date().toISOString() } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'article_id must be the id of an article' });
  assert.equal(await count('players'), 0);
  assert.equal(await count('verifications'), 0);
  const mock = await app.inject({ method: 'POST', url: '/verifications', payload: { device_id: device(1), display_name: 'Maya', article_id: 'mock-1', verified_at: new Date().toISOString() } });
  assert.equal(mock.statusCode, 400);
});

test('Scenario: Bad device id or name - 400 and nothing stored', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const body = { device_id: device(1), display_name: 'Maya', article_id: ids[0], verified_at: new Date().toISOString() };
  for (const bad of [{ device_id: 'not-a-uuid' }, { display_name: 'x'.repeat(41) }, { display_name: '' }, { display_name: '   ' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/verifications', payload: { ...body, ...bad } })).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(await count('players'), 0);
  assert.equal((await app.inject({ method: 'POST', url: '/verifications', payload: { ...body, display_name: 'x'.repeat(40) } })).statusCode, 204);
});

test('a future verification time is stored as the server time, and a past one as sent', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  const before = Date.now();
  await app.inject({ method: 'POST', url: '/verifications', payload: { device_id: device(1), display_name: 'Maya', article_id: ids[0], verified_at: '2099-01-01T00:00:00.000Z' } });
  const stored = (await pool!.query('SELECT verified_at FROM verifications')).rows[0].verified_at.getTime();
  assert.ok(stored >= before - 1000 && stored <= Date.now() + 1000, 'close to now, not 2099');
  await send(2, 0, 'Offline', 60 * 24 * 3);
  const old = (await pool!.query('SELECT verified_at FROM verifications WHERE device_id = $1', [device(2)])).rows[0].verified_at.getTime();
  assert.ok(Math.abs(old - (Date.now() - 3 * 24 * 60 * 60_000)) < 5000, 'three days ago, as the offline queue reported');
});

test('Scenario: No personal data - nothing but rank, name, count and the caller flag leaves the API', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  await send(1, 0, 'Maya');
  await send(2, 0, 'Daniel');
  const res = await app.inject({ method: 'GET', url: `/leaderboard?device_id=${device(1)}` });
  const text = res.body;
  assert.ok(!text.includes(device(1)) && !text.includes(device(2)), 'no device id');
  for (const row of [...res.json().rows, res.json().you]) assert.deepEqual(Object.keys(row).sort(), ['count', 'display_name', 'is_you', 'rank']);
  assert.deepEqual(Object.keys(res.json()).sort(), ['rows', 'you']);
});

test('Scenario: Rate limit with the real SQL behind it - the 61st post is refused and stores nothing more', async (t) => {
  if (skip) return t.skip(skip);
  await reset();
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await send(7, i % 3, 'Busy')).statusCode;
  assert.equal(last, 429);
  assert.equal(await count('verifications'), 3);
  assert.equal((await send(8, 0)).statusCode, 204); // another device is fine
});
