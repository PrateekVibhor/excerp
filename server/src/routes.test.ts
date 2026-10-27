import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApi } from './api.ts';
import type { ArticleReader } from './db.ts';
import type { LeaderboardResponse, LeaderboardStore, SyncVerification } from './leaderboard.ts';
import { createRateLimiter } from './rateLimit.ts';
import { MAX_BODY_BYTES, MAX_NAME_CHARS, normalizeDeviceId, parseVerification, POSTS_PER_HOUR, POSTS_PER_HOUR_PER_IP } from './routes/verifications.ts';

const DEVICE = '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90';
const ARTICLE = '5d1e6c2a-9a30-4c52-8d8e-1f0a7b2c3d44';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const good = { device_id: DEVICE, display_name: 'Maya Chen', article_id: ARTICLE, verified_at: '2026-10-06T11:59:00.000Z' };
const emptyReader: ArticleReader = { feed: async () => [], getById: async () => undefined };

function fakeBoard(opts: { response?: LeaderboardResponse; failWith?: unknown } = {}) {
  const recorded: Array<{ v: SyncVerification; now: Date | undefined }> = [];
  const asked: Array<string | undefined> = [];
  const board: LeaderboardStore = {
    async deleteDevice() {},
    async record(v, now) {
      if (opts.failWith) throw opts.failWith;
      recorded.push({ v, now });
      return true;
    },
    async leaderboard(device) {
      if (opts.failWith) throw opts.failWith;
      asked.push(device);
      return opts.response ?? { rows: [], you: null };
    },
  };
  return { board, recorded, asked };
}

async function app(board: LeaderboardStore, limiter = createRateLimiter({ max: POSTS_PER_HOUR, windowMs: 3_600_000 }), ipLimiter = createRateLimiter({ max: POSTS_PER_HOUR_PER_IP, windowMs: 3_600_000 })) {
  return buildApi({ ping: async () => {}, articles: emptyReader, leaderboard: board, limiter, ipLimiter, now: () => NOW });
}
const post = (a: Awaited<ReturnType<typeof app>>, payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  a.inject({ method: 'POST', url: '/verifications', headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });

test('the limits are 40 characters, 4 KB, 60 an hour per device and 120 an hour per address', () => {
  assert.equal(MAX_NAME_CHARS, 40);
  assert.equal(MAX_BODY_BYTES, 4096);
  assert.equal(POSTS_PER_HOUR, 60);
  assert.equal(POSTS_PER_HOUR_PER_IP, 120);
});

// ---- validation -------------------------------------------------------------------------------------

test('parseVerification accepts a good body, trims the name, lower-cases the ids and ignores extra fields', () => {
  const parsed = parseVerification({ ...good, device_id: DEVICE.toUpperCase(), article_id: ARTICLE.toUpperCase(), display_name: '  Maya Chen \n', extra: 'ignored' });
  assert.deepEqual(parsed, { ok: true, value: { device_id: DEVICE, display_name: 'Maya Chen', article_id: ARTICLE, verified_at: good.verified_at } });
});

test('Scenario: Bad device id - anything that is not a UUID is refused', () => {
  for (const bad of ['', 'not-a-uuid', `${DEVICE}0`, DEVICE.replace(/-/g, ''), 'mock-1', 42, null, undefined, {}, [DEVICE]]) {
    assert.deepEqual(parseVerification({ ...good, device_id: bad }), { ok: false, error: 'device_id must be a UUID' }, JSON.stringify(bad));
  }
  assert.deepEqual(parseVerification({ display_name: 'x', article_id: ARTICLE, verified_at: good.verified_at }), { ok: false, error: 'device_id must be a UUID' });
});

test('Scenario: Bad name - 1 to 40 characters once trimmed, counted as characters, no control characters', () => {
  const bad = (name: unknown) => parseVerification({ ...good, display_name: name });
  for (const name of ['', '   ', '\n\t', 'x'.repeat(41), '  ' + 'x'.repeat(41) + '  ', 7, null, undefined, ['a']]) assert.equal(bad(name).ok, false, JSON.stringify(name));
  assert.equal((bad('x') as { ok: boolean }).ok, true);
  assert.equal(bad('x'.repeat(40)).ok, true);
  assert.equal(bad(`  ${'x'.repeat(40)}  `).ok, true); // the spaces are trimmed first
  assert.equal(bad('🙂'.repeat(40)).ok, true); // 40 characters, though 80 UTF-16 units
  assert.equal(bad('🙂'.repeat(41)).ok, false);
  assert.equal(bad('Zoë Ünal').ok, true);
  assert.deepEqual(bad('two\nlines'), { ok: false, error: 'display_name must not contain control characters' });
  assert.equal(bad('tab\there').ok, false);
  assert.equal(bad('nul\u0000byte').ok, false);
  assert.deepEqual(bad('x'.repeat(41)), { ok: false, error: 'display_name must be 1 to 40 characters' });
});

test('an article id must be a UUID, so the app\'s mock ids are refused', () => {
  for (const bad of ['', 'mock-1', 'not-a-uuid', 7, null, undefined]) assert.deepEqual(parseVerification({ ...good, article_id: bad }), { ok: false, error: 'article_id must be the id of an article' }, JSON.stringify(bad));
});

test('verified_at must be a full ISO 8601 date and time', () => {
  for (const bad of ['', 'yesterday', '2026-10-06', '2026-10-06 11:59:00', '2026-13-45T25:61:61Z', '2026-10-06T11:59:00', 1760000000000, null, undefined]) {
    assert.deepEqual(parseVerification({ ...good, verified_at: bad }), { ok: false, error: 'verified_at must be an ISO 8601 date and time' }, JSON.stringify(bad));
  }
  for (const ok of ['2026-10-06T11:59:00Z', '2026-10-06T11:59:00.123Z', '2026-10-06T13:59:00+02:00', '2026-10-06T11:59:00.5-00:00']) assert.equal(parseVerification({ ...good, verified_at: ok }).ok, true, ok);
});

test('the body must be a JSON object', () => {
  for (const bad of [null, undefined, 'text', 7, [], [good], true]) assert.deepEqual(parseVerification(bad), { ok: false, error: 'the body must be a JSON object' }, JSON.stringify(bad));
});

test('normalizeDeviceId lower-cases a UUID and returns null for anything else', () => {
  assert.equal(normalizeDeviceId(DEVICE.toUpperCase()), DEVICE);
  assert.equal(normalizeDeviceId(DEVICE), DEVICE);
  for (const bad of ['', 'x', 5, null, undefined]) assert.equal(normalizeDeviceId(bad), null);
});

// ---- POST /verifications -----------------------------------------------------------------------------

test('POST /verifications answers 204 with no body and hands the store the checked values and the server time', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  const res = await post(a, { ...good, display_name: ' Maya Chen ', device_id: DEVICE.toUpperCase() });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.deepEqual(recorded.map((r) => r.v), [good]);
  assert.equal(recorded[0].now?.toISOString(), NOW.toISOString());
  await a.close();
});

test('Scenario: Bad input - every bad field answers 400 with a reason, and nothing is stored', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  const cases: Array<[unknown, string]> = [
    [{ ...good, device_id: 'nope' }, 'device_id must be a UUID'],
    [{ ...good, display_name: 'x'.repeat(41) }, 'display_name must be 1 to 40 characters'],
    [{ ...good, article_id: 'mock-1' }, 'article_id must be the id of an article'],
    [{ ...good, verified_at: 'whenever' }, 'verified_at must be an ISO 8601 date and time'],
    [[good], 'the body must be a JSON object'],
  ];
  for (const [payload, error] of cases) {
    const res = await post(a, payload);
    assert.equal(res.statusCode, 400, error);
    assert.deepEqual(res.json(), { error });
  }
  assert.deepEqual(recorded, []);
  await a.close();
});

test('a body that is not JSON, or has no body, is a 400 and nothing is stored', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  assert.equal((await post(a, '{"device_id": ')).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/verifications' })).statusCode, 400);
  assert.deepEqual(recorded, []);
  await a.close();
});

test('only JSON is accepted: the same fields sent as text or a form are refused, and nothing is stored', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  const asText = await post(a, JSON.stringify(good), { 'content-type': 'text/plain' }); // read as a plain string, which is not an object
  assert.equal(asText.statusCode, 400);
  assert.deepEqual(asText.json(), { error: 'the body must be a JSON object' });
  const asForm = await post(a, 'device_id=x', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(asForm.statusCode, 415);
  assert.equal((await a.inject({ method: 'POST', url: '/verifications', payload: JSON.stringify(good) })).statusCode, 415); // no content type at all
  assert.deepEqual(recorded, []);
  await a.close();
});

test('a body over 4 KB is refused before it is read in full', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  const res = await post(a, { ...good, padding: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal(res.statusCode, 413);
  assert.deepEqual(recorded, []);
  await a.close();
});

test('Scenario: Unknown article - the database says no, and the app is told 400', async () => {
  const fk = Object.assign(new Error('insert or update on table "verifications" violates foreign key constraint'), { code: '23503', constraint: 'verifications_article_id_fkey' });
  const a = await app(fakeBoard({ failWith: fk }).board);
  const res = await post(a, good);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'article_id must be the id of an article' });
  await a.close();
});

test('any other database failure is a 503 that says nothing about the database', async () => {
  const a = await app(fakeBoard({ failWith: new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2') }).board);
  const res = await post(a, good);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: 'verification not saved' });
  assert.ok(!res.body.includes('hunter2') && !res.body.includes('10.0.0.5'));
  // a foreign key failure on some other column is not mistaken for an unknown article
  const other = Object.assign(new Error('x'), { code: '23503', constraint: 'verifications_device_id_fkey' });
  assert.equal((await post(await app(fakeBoard({ failWith: other }).board), good)).statusCode, 503);
  await a.close();
});

test('Scenario: Rate limit - the 61st post from one device within an hour is 429, and does not reach the store', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  for (let i = 1; i <= 60; i++) assert.equal((await post(a, good)).statusCode, 204, `post ${i}`);
  const over = await post(a, good);
  assert.equal(over.statusCode, 429);
  assert.deepEqual(over.json(), { error: 'too many verifications; try again later' });
  assert.equal(recorded.length, 60);
  // another device is not affected, and the same device with a bad body is still a 400, not a 429
  assert.equal((await post(a, { ...good, device_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })).statusCode, 204);
  assert.equal((await post(a, { ...good, display_name: '' })).statusCode, 400);
  await a.close();
});

test('the limit counts a device whatever the case of its id', async () => {
  const a = await app(fakeBoard().board, createRateLimiter({ max: 2, windowMs: 3_600_000 }));
  assert.equal((await post(a, good)).statusCode, 204);
  assert.equal((await post(a, { ...good, device_id: DEVICE.toUpperCase() })).statusCode, 204);
  assert.equal((await post(a, good)).statusCode, 429);
  await a.close();
});

test('invalid posts do not use up the allowance', async () => {
  const a = await app(fakeBoard().board, createRateLimiter({ max: 1, windowMs: 3_600_000 }));
  for (let i = 0; i < 5; i++) assert.equal((await post(a, { ...good, article_id: 'bad' })).statusCode, 400);
  assert.equal((await post(a, good)).statusCode, 204);
});

test('the default limiter is 60 an hour: still refused after a minute, allowed again after the hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00Z') });
  const a = await buildApi({ ping: async () => {}, articles: emptyReader, leaderboard: fakeBoard().board });
  for (let i = 0; i < 60; i++) assert.equal((await post(a, good)).statusCode, 204);
  assert.equal((await post(a, good)).statusCode, 429);
  t.mock.timers.tick(60_000);
  assert.equal((await post(a, good)).statusCode, 429); // a minute later: no
  t.mock.timers.tick(59 * 60_000 - 1);
  assert.equal((await post(a, good)).statusCode, 429); // one millisecond short of the hour: no
  t.mock.timers.tick(1);
  assert.equal((await post(a, good)).statusCode, 204); // the hour is up for the first 60
  await a.close();
});

test('the browser may POST from another origin', async () => {
  const a = await app(fakeBoard().board);
  const pre = await a.inject({ method: 'OPTIONS', url: '/verifications', headers: { origin: 'https://example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.ok(pre.statusCode === 204 || pre.statusCode === 200);
  assert.match(String(pre.headers['access-control-allow-methods']), /POST/);
  await a.close();
});

// ---- GET /leaderboard --------------------------------------------------------------------------------

test('GET /leaderboard returns what the store returns, and asks for no particular caller by default', async () => {
  const response: LeaderboardResponse = { rows: [{ rank: 1, display_name: 'Maya', count: 3, is_you: false }], you: null };
  const { board, asked } = fakeBoard({ response });
  const a = await app(board);
  const res = await a.inject({ method: 'GET', url: '/leaderboard' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), response);
  assert.deepEqual(asked, [undefined]);
  assert.equal(res.headers['cache-control'], 'no-store');
  await a.close();
});

test('GET /leaderboard?device_id= passes the lower-cased device id on, and an empty one means no caller', async () => {
  const { board, asked } = fakeBoard();
  const a = await app(board);
  await a.inject({ method: 'GET', url: `/leaderboard?device_id=${DEVICE.toUpperCase()}` });
  await a.inject({ method: 'GET', url: '/leaderboard?device_id=' });
  assert.deepEqual(asked, [DEVICE, undefined]);
  await a.close();
});

test('GET /leaderboard with a device id that is not a UUID is a 400', async () => {
  const { board, asked } = fakeBoard();
  const a = await app(board);
  for (const bad of ['nope', 'mock-1', `${DEVICE}0`]) {
    const res = await a.inject({ method: 'GET', url: `/leaderboard?device_id=${bad}` });
    assert.equal(res.statusCode, 400, bad);
    assert.deepEqual(res.json(), { error: 'device_id must be a UUID' });
  }
  assert.deepEqual(asked, []);
  await a.close();
});

test('GET /leaderboard when the database fails is a 503 without details', async () => {
  const a = await app(fakeBoard({ failWith: new Error('password=hunter2') }).board);
  const res = await a.inject({ method: 'GET', url: '/leaderboard' });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: 'leaderboard unavailable' });
  assert.ok(!res.body.includes('hunter2'));
  await a.close();
});

test('only the two new routes accept the new methods: nothing else became writable', async () => {
  const a = await app(fakeBoard().board);
  for (const [method, url] of [['POST', '/feed'], ['POST', '/leaderboard'], ['PUT', '/verifications'], ['GET', '/verifications'], ['DELETE', '/leaderboard'], ['POST', '/articles/x']] as const) {
    assert.equal((await a.inject({ method, url })).statusCode, 404, `${method} ${url}`);
  }
  await a.close();
});

// ---- the per-address limit ---------------------------------------------------------------------------

const deviceN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const postFrom = (a: Awaited<ReturnType<typeof app>>, n: number, remoteAddress: string, headers: Record<string, string> = {}) =>
  a.inject({ method: 'POST', url: '/verifications', remoteAddress, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify({ ...good, device_id: deviceN(n) }) });

test('Scenario: Many devices from one address - the 121st post from one address is 429, whichever devices sent them', async () => {
  const { board, recorded } = fakeBoard();
  const a = await app(board);
  for (let i = 1; i <= 120; i++) assert.equal((await postFrom(a, i, '203.0.113.7')).statusCode, 204, `post ${i}`); // 120 different devices
  const over = await postFrom(a, 121, '203.0.113.7');
  assert.equal(over.statusCode, 429);
  assert.deepEqual(over.json(), { error: 'too many verifications; try again later' });
  assert.equal(recorded.length, 120);
  await a.close();
});

test('another address is not affected', async () => {
  const a = await app(fakeBoard().board, undefined, createRateLimiter({ max: 2, windowMs: 3_600_000 }));
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 204);
  assert.equal((await postFrom(a, 2, '203.0.113.7')).statusCode, 204);
  assert.equal((await postFrom(a, 3, '203.0.113.7')).statusCode, 429);
  assert.equal((await postFrom(a, 3, '198.51.100.9')).statusCode, 204);
  assert.equal((await postFrom(a, 4, '2001:db8::1')).statusCode, 204); // an IPv6 address is its own key
  await a.close();
});

test('X-Forwarded-For cannot be used to dodge the limit: the connection\'s own address is what counts', async () => {
  const a = await app(fakeBoard().board, undefined, createRateLimiter({ max: 2, windowMs: 3_600_000 }));
  for (const [n, spoof] of [[1, '10.0.0.1'], [2, '10.0.0.2']] as const) assert.equal((await postFrom(a, n, '203.0.113.7', { 'x-forwarded-for': spoof })).statusCode, 204);
  assert.equal((await postFrom(a, 3, '203.0.113.7', { 'x-forwarded-for': '10.0.0.3' })).statusCode, 429);
  assert.equal((await postFrom(a, 4, '203.0.113.7', { 'x-forwarded-for': '10.0.0.4, 10.0.0.5', forwarded: 'for=10.0.0.6' })).statusCode, 429);
  await a.close();
});

test('a post refused for its address does not use up that device\'s own allowance', async () => {
  const a = await app(fakeBoard().board, createRateLimiter({ max: 1, windowMs: 3_600_000 }), createRateLimiter({ max: 1, windowMs: 3_600_000 }));
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 204); // address and device 1 are now used up
  assert.equal((await postFrom(a, 2, '203.0.113.7')).statusCode, 429); // refused for the address
  assert.equal((await postFrom(a, 2, '198.51.100.9')).statusCode, 204); // device 2 still has its own allowance elsewhere
  await a.close();
});

test('a post refused for its device still counts against its address', async () => {
  const a = await app(fakeBoard().board, createRateLimiter({ max: 1, windowMs: 3_600_000 }), createRateLimiter({ max: 3, windowMs: 3_600_000 }));
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 204);
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 429); // the device is used up
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 429);
  assert.equal((await postFrom(a, 2, '203.0.113.7')).statusCode, 429); // the address has now seen 3: this one is refused for it
  await a.close();
});

test('invalid posts do not use up an address\'s allowance', async () => {
  const a = await app(fakeBoard().board, undefined, createRateLimiter({ max: 1, windowMs: 3_600_000 }));
  for (let i = 0; i < 5; i++) {
    const res = await a.inject({ method: 'POST', url: '/verifications', remoteAddress: '203.0.113.7', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...good, article_id: 'bad' }) });
    assert.equal(res.statusCode, 400);
  }
  assert.equal((await postFrom(a, 1, '203.0.113.7')).statusCode, 204);
  await a.close();
});

test('the default per-address limit is 120 an hour, and rolls', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00Z') });
  const a = await buildApi({ ping: async () => {}, articles: emptyReader, leaderboard: fakeBoard().board });
  for (let i = 1; i <= 120; i++) assert.equal((await postFrom(a, i, '203.0.113.7')).statusCode, 204, `post ${i}`);
  assert.equal((await postFrom(a, 121, '203.0.113.7')).statusCode, 429);
  t.mock.timers.tick(60 * 60_000 - 1);
  assert.equal((await postFrom(a, 121, '203.0.113.7')).statusCode, 429);
  t.mock.timers.tick(1);
  assert.equal((await postFrom(a, 121, '203.0.113.7')).statusCode, 204);
  await a.close();
});
