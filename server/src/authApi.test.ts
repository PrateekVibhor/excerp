// The sign-in routes through the real API and the real SQL, in a throwaway schema. Google is replaced by a fake verifier.
// Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { buildApi } from './api.ts';
import { InvalidTokenError, TokenServiceUnavailableError, type GoogleIdentity, type TokenVerifier } from './auth.ts';
import { createAuthStore, SESSION_DAYS, type AuthStore } from './authStore.ts';
import { createArticleReader } from './db.ts';
import { createLeaderboardStore } from './leaderboard.ts';
import { createRateLimiter } from './rateLimit.ts';
import { SIGN_INS_PER_HOUR_PER_EMAIL, SIGN_INS_PER_HOUR_PER_IP } from './routes/auth.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `authapi_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let store: AuthStore;
let skip: string | false = false;
let app: Awaited<ReturnType<typeof buildApi>>;
let clock = new Date('2026-10-09T12:00:00.000Z');

const identities: Record<string, GoogleIdentity> = {
  tester: { email: 'tester@example.com', email_verified: true, sub: 'sub-tester' },
  mixed: { email: 'TESTER@Example.com', email_verified: true, sub: 'sub-tester' },
  stranger: { email: 'stranger@example.com', email_verified: true, sub: 'sub-stranger' },
  unverified: { email: 'tester@example.com', email_verified: false, sub: 'sub-tester' },
};
const verify: TokenVerifier = async (idToken) => {
  if (idToken === 'forged') throw new InvalidTokenError('no');
  if (idToken === 'down') throw new TokenServiceUnavailableError('no');
  if (idToken === 'boom') throw new Error('something else broke');
  return identities[idToken];
};

async function build(limits: { ip?: number; email?: number; allowAny?: boolean } = {}) {
  return buildApi({
    ping: async () => {},
    articles: createArticleReader(pool!),
    leaderboard: createLeaderboardStore(pool!),
    auth: {
      verify,
      store,
      ipLimiter: createRateLimiter({ max: limits.ip ?? 1_000_000, windowMs: 3_600_000 }),
      emailLimiter: createRateLimiter({ max: limits.email ?? 1_000_000, windowMs: 3_600_000 }),
      allowAnyAccount: limits.allowAny,
    },
    now: () => clock,
  });
}

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
  store = createAuthStore(pool);
  app = await build();
});
after(async () => {
  if (!pool) return;
  await app.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await pool!.query('TRUNCATE allowed_emails, access_requests, sessions');
    clock = new Date('2026-10-09T12:00:00.000Z');
    await fn();
  });

const signIn = (idToken: unknown, server = app) => server.inject({ method: 'POST', url: '/auth/google', payload: { id_token: idToken } });
const session = (token?: string, scheme = 'Bearer') => app.inject({ method: 'GET', url: '/auth/session', headers: token === undefined ? {} : { authorization: `${scheme} ${token}` } });
const rows = async (table: string) => (await pool!.query(`SELECT * FROM ${table}`)).rows;

// ---- POST /auth/google -----------------------------------------------------------------------------

t('Scenario: Approved email - a verified email on the list gets a session token, and only its hash is stored', async () => {
  await store.addAllowed('tester@example.com');
  const res = await signIn('tester');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'approved');
  assert.match(body.session_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.expires_at, new Date(clock.getTime() + SESSION_DAYS * 86_400_000).toISOString());
  const stored = await rows('sessions');
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(body.session_token));
  assert.equal((await rows('access_requests')).length, 0);
});

t('Scenario: Email not on the list - the answer is "pending" with no token, and the email and time are remembered', async () => {
  const res = await signIn('stranger');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'pending' });
  assert.equal((await rows('sessions')).length, 0);
  const [request] = await rows('access_requests');
  assert.deepEqual(Object.keys(request).sort(), ['email', 'first_requested_at', 'last_requested_at']);
  assert.equal(request.email, 'stranger@example.com');
});

t('Scenario: Letter case - "Tester@Example.com" is stored in lower case and a token for "TESTER@example.com" is approved', async () => {
  await store.addAllowed('Tester@Example.com');
  assert.deepEqual((await rows('allowed_emails')).map((r) => r.email), ['tester@example.com']);
  assert.equal((await signIn('mixed')).json().status, 'approved');
});

t('Scenario: Unverified Google email - "pending" even when the email is on the list, and nothing is remembered about it', async () => {
  await store.addAllowed('tester@example.com');
  const res = await signIn('unverified');
  assert.deepEqual(res.json(), { status: 'pending' });
  assert.equal((await rows('sessions')).length, 0);
  assert.equal((await rows('access_requests')).length, 0); // an address Google has not verified is not recorded as a request
});

t('Scenario: Bad token - 401, and nothing is stored', async () => {
  const res = await signIn('forged');
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: 'invalid token' });
  for (const table of ['sessions', 'access_requests', 'allowed_emails']) assert.equal((await rows(table)).length, 0);
});

t('Scenario: Google unreachable - 503, and nothing is stored', async () => {
  assert.equal((await signIn('down')).statusCode, 503);
  assert.equal((await signIn('boom')).statusCode, 503); // anything unexpected is "try again later", never "approved"
  assert.equal((await rows('sessions')).length, 0);
});

t('Scenario: Same answer for every unapproved reader - never listed and removed from the list look identical', async () => {
  await store.addAllowed('tester@example.com');
  await store.removeAllowed('tester@example.com');
  const removed = await signIn('tester');
  const never = await signIn('stranger');
  assert.equal(removed.statusCode, never.statusCode);
  assert.equal(removed.body, never.body);
});

t('a body that is not { id_token: text } is a 400 and is not checked with Google', async () => {
  for (const payload of [{}, { id_token: 5 }, { id_token: '' }, { id_token: 'x'.repeat(4097) }, [], 'text']) {
    const res = await app.inject({ method: 'POST', url: '/auth/google', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 40));
  }
  assert.equal((await app.inject({ method: 'POST', url: '/auth/google' })).statusCode, 400);
});

t('responses are never cached', async () => {
  assert.equal((await signIn('stranger')).headers['cache-control'], 'no-store');
  assert.equal((await session('x')).headers['cache-control'], 'no-store');
});

t('Scenario: Rate limit - the 31st sign-in from one address in an hour is a 429', async () => {
  const limited = await build({ ip: SIGN_INS_PER_HOUR_PER_IP });
  for (let i = 0; i < SIGN_INS_PER_HOUR_PER_IP; i++) assert.equal((await signIn('stranger', limited)).statusCode, 200, `request ${i + 1}`);
  assert.equal((await signIn('stranger', limited)).statusCode, 429);
  await limited.close();
});

t('one email can sign in only 10 times an hour, whatever address it comes from', async () => {
  const limited = await build({ email: SIGN_INS_PER_HOUR_PER_EMAIL });
  for (let i = 0; i < SIGN_INS_PER_HOUR_PER_EMAIL; i++) assert.equal((await signIn('stranger', limited)).statusCode, 200);
  assert.equal((await signIn('stranger', limited)).statusCode, 429);
  assert.equal((await signIn('tester', limited)).statusCode, 200); // another email is not affected
  await limited.close();
});

t('the limits are 30 an hour per address and 10 an hour per email', () => {
  assert.equal(SIGN_INS_PER_HOUR_PER_IP, 30);
  assert.equal(SIGN_INS_PER_HOUR_PER_EMAIL, 10);
  return Promise.resolve();
});

// ---- GET /auth/session -----------------------------------------------------------------------------

t('a session of an approved email is "approved" and says when it ends', async () => {
  await store.addAllowed('tester@example.com');
  const { session_token } = (await signIn('tester')).json();
  const res = await session(session_token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'approved');
  assert.ok(Date.parse(res.json().expires_at) > clock.getTime());
});

t('Scenario: Removal is live - after the email is removed the same session gets 403, and works again when it is added back', async () => {
  await store.addAllowed('tester@example.com');
  const { session_token } = (await signIn('tester')).json();
  await store.removeAllowed('tester@example.com');
  const removed = await session(session_token);
  assert.equal(removed.statusCode, 403);
  assert.deepEqual(removed.json(), { status: 'pending' });
  await store.addAllowed('tester@example.com');
  assert.equal((await session(session_token)).statusCode, 200);
});

t('no token, a token that is not known, the wrong scheme, and an expired session are each a 401', async () => {
  await store.addAllowed('tester@example.com');
  const { session_token } = (await signIn('tester')).json();
  assert.equal((await session()).statusCode, 401);
  assert.equal((await session('not-a-real-token')).statusCode, 401);
  assert.equal((await session(session_token, 'Basic')).statusCode, 401);
  assert.equal((await session(session_token, 'Bearer ')).statusCode, 401);
  clock = new Date(clock.getTime() + (SESSION_DAYS + 1) * 86_400_000);
  assert.equal((await session(session_token)).statusCode, 401);
});

t('a 401 does not say why', async () => {
  const a = await session('unknown-token');
  const b = await session();
  assert.deepEqual(a.json(), { error: 'not signed in' });
  assert.deepEqual(b.json(), { error: 'not signed in' });
});

t('Scenario: Sliding expiry - using a session ten days in extends it to 30 days from that use', async () => {
  await store.addAllowed('tester@example.com');
  const { session_token } = (await signIn('tester')).json();
  clock = new Date(clock.getTime() + 10 * 86_400_000);
  const res = await session(session_token);
  assert.equal(res.json().expires_at, new Date(clock.getTime() + SESSION_DAYS * 86_400_000).toISOString());
});

// ---- POST /auth/signout ----------------------------------------------------------------------------

t('Scenario: Sign out on the server - 204, the row is gone, and the token is a 401 afterwards', async () => {
  await store.addAllowed('tester@example.com');
  const { session_token } = (await signIn('tester')).json();
  const out = await app.inject({ method: 'POST', url: '/auth/signout', headers: { authorization: `Bearer ${session_token}` } });
  assert.equal(out.statusCode, 204);
  assert.equal((await rows('sessions')).length, 0);
  assert.equal((await session(session_token)).statusCode, 401);
});

t('signing out again, with an unknown token, or with no token is still a 204', async () => {
  for (const headers of [{ authorization: 'Bearer gone' }, {}]) {
    assert.equal((await app.inject({ method: 'POST', url: '/auth/signout', headers })).statusCode, 204);
  }
});

t('signing out one reader leaves another reader\'s session alone', async () => {
  await store.addAllowed('tester@example.com');
  const a = (await signIn('tester')).json().session_token;
  const b = (await signIn('tester')).json().session_token;
  await app.inject({ method: 'POST', url: '/auth/signout', headers: { authorization: `Bearer ${a}` } });
  assert.equal((await session(b)).statusCode, 200);
});

// ---- the rest of the API is not touched yet --------------------------------------------------------

t('Scenario: Health stays open - and the feed is unchanged for now (Stage A does not guard it)', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/feed' })).statusCode, 200);
});

// ---- the "anyone with a Google account" setting (for a demo or a hackathon) -------------------------

const session2 = (server: typeof app, token: string) => server.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${token}` } });

t('by default a verified email that is not on the list is not approved (the setting is off unless asked for)', async () => {
  assert.deepEqual((await signIn('stranger')).json(), { status: 'pending' });
});

t('Scenario: Open access - with ALLOW_ANY_GOOGLE_ACCOUNT on, a verified email that is not on the list gets a session', async () => {
  const open = await build({ allowAny: true });
  const res = await signIn('stranger', open);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'approved');
  assert.match(res.json().session_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await rows('access_requests')).length, 0); // nobody is waiting, so nothing to approve later
  assert.equal((await session2(open, res.json().session_token)).statusCode, 200); // and the session works
  await open.close();
});

t('open access still never approves an email Google has not verified', async () => {
  const open = await build({ allowAny: true });
  assert.deepEqual((await signIn('unverified', open)).json(), { status: 'pending' });
  assert.equal((await rows('sessions')).length, 0);
  await open.close();
});

t('open access still refuses a bad token and still reports Google being unreachable', async () => {
  const open = await build({ allowAny: true });
  assert.equal((await signIn('forged', open)).statusCode, 401);
  assert.equal((await signIn('down', open)).statusCode, 503);
  await open.close();
});

t('turning open access off again stops sessions made while it was on, unless the email is on the list', async () => {
  const open = await build({ allowAny: true });
  const stranger = (await signIn('stranger', open)).json().session_token;
  await store.addAllowed('tester@example.com');
  const listed = (await signIn('tester', open)).json().session_token;
  await open.close();
  const closed = await build({ allowAny: false }); // the same database, the setting off
  assert.equal((await session2(closed, stranger)).statusCode, 403);
  assert.deepEqual((await session2(closed, stranger)).json(), { status: 'pending' });
  assert.equal((await session2(closed, listed)).statusCode, 200);
  await closed.close();
});

t('a listed email works the same with the setting on or off', async () => {
  await store.addAllowed('tester@example.com');
  for (const allowAny of [false, true]) {
    const server = await build({ allowAny });
    assert.equal((await signIn('tester', server)).json().status, 'approved');
    await server.close();
  }
});

