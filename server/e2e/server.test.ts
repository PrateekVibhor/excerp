// The end-to-end test server, against the real SQL in its own throwaway schema. Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { mockArticles } from '../../src/data/mockArticles.ts';
import { createGoogleVerifier, InvalidTokenError } from '../src/auth.ts';
import { articleId, createE2eServer, createTestVerifier, type E2eServer } from './server.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
let skip: string | false = false;
let server: E2eServer;

before(async () => {
  const probe = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await probe.query('SELECT 1');
  } catch {
    skip = 'no database reachable';
    return;
  } finally {
    await probe.end();
  }
  server = await createE2eServer({ databaseUrl: url });
});
after(async () => {
  if (server) await server.stop();
});

const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await server.app.inject({ method: 'POST', url: '/e2e/reset' });
    await fn();
  });

const api = (method: 'GET' | 'POST', path: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({ method, url: path, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } }) }); // a JSON content type goes with a body only, as the real API requires
const signIn = async (token: string) => (await api('POST', '/auth/google', { id_token: token })).json();
const count = async (table: string) => Number((await server.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

// ---- the test verifier (needs no database) --------------------------------------------------------

test('the test verifier turns an "e2e:" token into that email, verified', async () => {
  const verify = createTestVerifier();
  assert.deepEqual(await verify('e2e:tester@example.com'), { email: 'tester@example.com', email_verified: true, sub: 'e2e-sub-tester@example.com' });
  assert.deepEqual(await verify('e2e:stranger@example.com'), { email: 'stranger@example.com', email_verified: true, sub: 'e2e-sub-stranger@example.com' });
});

test('the unverified test reader is not verified', async () => {
  assert.deepEqual(await createTestVerifier()('e2e:unverified@example.com'), { email: 'unverified@example.com', email_verified: false, sub: 'e2e-sub-unverified@example.com' });
});

test('it accepts only tokens that start with "e2e:" and hold an email address', async () => {
  const verify = createTestVerifier();
  for (const bad of ['', 'tester@example.com', 'E2E:tester@example.com', 'e2e:', 'e2e:not-an-email', 'e2e: a b@c.com', 'a.b.c', 'x'.repeat(5000)]) {
    await assert.rejects(verify(bad), InvalidTokenError, bad.slice(0, 30));
  }
});

test('Scenario: Test token on the real verifier - the real Google check refuses an "e2e:" token', async () => {
  const real = createGoogleVerifier({ clientId: 'web.apps.googleusercontent.com', getCerts: async () => ({}) });
  await assert.rejects(real('e2e:tester@example.com'), InvalidTokenError);
});

// ---- the server -----------------------------------------------------------------------------------

t('it is up: /e2e/ready answers 200, and so does the real /health', async () => {
  assert.equal((await api('GET', '/e2e/ready')).statusCode, 200);
  assert.equal((await api('GET', '/health')).statusCode, 200);
});

t('Scenario: Reset - the nine sample articles are present with fixed ids, as the app has them', async () => {
  const { rows } = await server.pool.query('SELECT id, title, quiz FROM articles ORDER BY id');
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 9 }, (_, i) => articleId(i + 1)));
  assert.equal(articleId(1), '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(rows.map((r) => r.title), mockArticles.map((a) => a.title));
});

t('only the first three sample articles have a quiz (three questions each), exactly as in the app\'s sample data', async () => {
  const { rows } = await server.pool.query('SELECT id, quiz FROM articles ORDER BY id');
  assert.deepEqual(rows.map((r) => r.quiz !== null), mockArticles.map((a) => a.quiz !== undefined && a.quiz !== null));
  assert.deepEqual(rows.map((r) => r.quiz !== null), [true, true, true, false, false, false, false, false, false]);
  for (const r of rows.filter((r) => r.quiz)) assert.equal(r.quiz.questions.length, 3);
});

t('the feed, through the real API, serves the nine articles', async () => {
  const feed = (await api('GET', '/feed?limit=30')).json();
  assert.equal(feed.length, 9);
  assert.equal(feed.filter((a: { quiz: unknown }) => a.quiz !== null).length, 3);
});

t('Scenario: Reset - verifications, sessions, players and requests are gone, and only the approved test reader is on the allow-list', async () => {
  await api('POST', '/e2e/allow', { email: 'stranger@example.com' });
  await signIn('e2e:stranger@example.com');
  await api('POST', '/verifications', { device_id: '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', display_name: 'Reader', article_id: articleId(1), verified_at: new Date().toISOString() });
  assert.ok((await count('sessions')) > 0 && (await count('verifications')) > 0);
  await api('POST', '/e2e/reset');
  for (const table of ['sessions', 'verifications', 'players', 'access_requests']) assert.equal(await count(table), 0, table);
  assert.deepEqual((await server.pool.query('SELECT email FROM allowed_emails')).rows.map((r) => r.email), ['tester@example.com']);
  assert.equal(await count('articles'), 9);
});

t('Scenario: Approved reader - the approved test reader gets a session', async () => {
  const body = await signIn('e2e:tester@example.com');
  assert.equal(body.status, 'approved');
  assert.ok(body.session_token);
});

t('a reader who is not approved is pending, and so is the unverified one', async () => {
  assert.deepEqual(await signIn('e2e:stranger@example.com'), { status: 'pending' });
  assert.deepEqual(await signIn('e2e:unverified@example.com'), { status: 'pending' });
});

t('Scenario: Approving a waiting reader from a flow - after /e2e/allow the next sign-in is approved', async () => {
  assert.equal((await signIn('e2e:stranger@example.com')).status, 'pending');
  const res = await api('POST', '/e2e/allow', { email: 'stranger@example.com' });
  assert.equal(res.statusCode, 200);
  assert.equal((await signIn('e2e:stranger@example.com')).status, 'approved');
});

t('/e2e/allow refuses a body without a proper email', async () => {
  for (const body of [{}, { email: 'nope' }, { email: 5 }]) assert.equal((await api('POST', '/e2e/allow', body)).statusCode, 400);
  assert.equal(await count('allowed_emails'), 1);
});

t('a real-looking Google token is refused: only "e2e:" tokens work here', async () => {
  assert.equal((await api('POST', '/auth/google', { id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jb20ifQ.c2ln' })).statusCode, 401);
});

t('Scenario: Leaderboard failure switch - down makes /leaderboard answer 503, and up makes it answer normally', async () => {
  assert.equal((await api('GET', '/leaderboard')).statusCode, 200);
  assert.equal((await api('POST', '/e2e/leaderboard-down', { down: true })).statusCode, 200);
  assert.equal((await api('GET', '/leaderboard')).statusCode, 503);
  assert.equal((await api('POST', '/e2e/leaderboard-down', { down: false })).statusCode, 200);
  assert.equal((await api('GET', '/leaderboard')).statusCode, 200);
});

t('the failure switch affects only the leaderboard, and a reset turns it off', async () => {
  await api('POST', '/e2e/leaderboard-down', { down: true });
  assert.equal((await api('GET', '/feed')).statusCode, 200);
  assert.equal((await api('GET', '/health')).statusCode, 200);
  const post = await api('POST', '/verifications', { device_id: '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', display_name: 'Reader', article_id: articleId(2), verified_at: new Date().toISOString() });
  assert.equal(post.statusCode, 204); // a quiz can still be verified while the board cannot be read
  await api('POST', '/e2e/reset');
  assert.equal((await api('GET', '/leaderboard')).statusCode, 200);
});

t('/e2e/leaderboard-down needs a true or false', async () => {
  for (const body of [{}, { down: 'yes' }, { down: 1 }]) assert.equal((await api('POST', '/e2e/leaderboard-down', body)).statusCode, 400);
});

t('a verification of a seeded article reaches the leaderboard, as the app would send it', async () => {
  const device = '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90';
  assert.equal((await api('POST', '/verifications', { device_id: device, display_name: 'Reader', article_id: articleId(3), verified_at: new Date().toISOString() })).statusCode, 204);
  const board = (await api('GET', `/leaderboard?device_id=${device}`)).json();
  assert.deepEqual(board.you, { rank: 1, display_name: 'Reader', count: 1, is_you: true });
});

t('many sign-ins and verifications in a row are not rate limited, so repeated runs do not fail', async () => {
  for (let i = 0; i < 40; i++) assert.equal((await signIn('e2e:tester@example.com')).status, 'approved', `sign-in ${i + 1}`);
});

test('it listens on this machine only', async (ctx) => {
  if (skip) return ctx.skip(skip);
  const other = await createE2eServer({ databaseUrl: url, port: 0 });
  try {
    const { host, port } = await other.listen();
    assert.equal(host, '127.0.0.1');
    assert.ok(port > 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/e2e/ready`)).status, 200);
  } finally {
    await other.stop();
  }
});

test('stopping drops its throwaway schema', async (ctx) => {
  if (skip) return ctx.skip(skip);
  const other = await createE2eServer({ databaseUrl: url, port: 0 });
  const schema = other.schema;
  const admin = new pg.Pool({ connectionString: url });
  try {
    assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount, 1);
    await other.stop();
    assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount, 0);
  } finally {
    await admin.end();
  }
});

test('the server never touches the real tables: its schema is its own', async (ctx) => {
  if (skip) return ctx.skip(skip);
  assert.match(server.schema, /^e2e_\d+_\d+$/);
  const admin = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await admin.query(`SELECT current_schemas(false) AS s`);
    assert.ok(!(rows[0].s as string[]).includes(server.schema)); // other connections do not see it
  } finally {
    await admin.end();
  }
});

t('reset also works the way Maestro calls it: a POST with "{}" as its JSON body (its http.post must send a body)', async () => {
  await api('POST', '/e2e/allow', { email: 'stranger@example.com' });
  const res = await api('POST', '/e2e/reset', {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await server.pool.query('SELECT email FROM allowed_emails')).rows.map((r) => r.email), ['tester@example.com']);
});

test('stopping twice at once (a Ctrl-C reaches the server and the script together) still drops the schema before either call returns', async (ctx) => {
  if (skip) return ctx.skip(skip);
  const other = await createE2eServer({ databaseUrl: url, port: 0 });
  const schema = other.schema;
  const admin = new pg.Pool({ connectionString: url });
  try {
    void other.stop();
    await other.stop(); // the second call must wait for the first to finish, because the caller exits as soon as it returns
    assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount, 0);
  } finally {
    await admin.end();
  }
});

