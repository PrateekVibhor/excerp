// The allow-list and sessions against the real SQL, in a throwaway schema that is dropped afterwards.
// Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createAuthStore, SESSION_DAYS, type AuthStore } from './authStore.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `auth_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let store: AuthStore;
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
  store = createAuthStore(pool);
});
after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const NOW = new Date('2026-10-09T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const reset = () => pool!.query('TRUNCATE allowed_emails, access_requests, sessions');
const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await reset();
    await fn();
  });

t('an email is allowed once added, whatever its letter case, and not before', async () => {
  assert.equal(await store.isAllowed('tester@example.com'), false);
  assert.equal(await store.addAllowed('  Tester@Example.com '), true);
  assert.equal(await store.isAllowed('tester@example.com'), true);
  assert.equal(await store.isAllowed('TESTER@EXAMPLE.COM'), true);
  assert.deepEqual((await store.listAllowed()).map((r) => r.email), ['tester@example.com']); // stored lower case
});

t('adding the same email twice keeps one row and says it was not new', async () => {
  assert.equal(await store.addAllowed('a@b.com'), true);
  assert.equal(await store.addAllowed('A@B.com'), false);
  assert.equal((await store.listAllowed()).length, 1);
});

t('removing an email stops it being allowed; removing one that is not there says so', async () => {
  await store.addAllowed('a@b.com');
  assert.equal(await store.removeAllowed('A@b.com'), true);
  assert.equal(await store.isAllowed('a@b.com'), false);
  assert.equal(await store.removeAllowed('a@b.com'), false);
});

t('text that is not an email address is refused, not stored', async () => {
  for (const bad of ['', 'plain', 'a@b', 'a b@c.com']) {
    await assert.rejects(store.addAllowed(bad), RangeError);
    await assert.rejects(store.isAllowed(bad), RangeError);
  }
  assert.equal((await store.listAllowed()).length, 0);
});

t('a sign-in that was not approved is remembered by email and time, first and latest', async () => {
  await store.recordRequest('Stranger@Example.com', NOW);
  await store.recordRequest('stranger@example.com', days(2));
  const [row] = await store.listPending();
  assert.equal(row.email, 'stranger@example.com');
  assert.equal(row.first_requested_at.toISOString(), NOW.toISOString());
  assert.equal(row.last_requested_at.toISOString(), days(2).toISOString());
});

t('what is kept about a reader who was not approved is the email and two times, nothing more', async () => {
  const { rows } = await pool!.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'access_requests' ORDER BY column_name`, [schema]);
  assert.deepEqual(rows.map((r) => r.column_name), ['email', 'first_requested_at', 'last_requested_at']);
});

t('the pending list leaves out emails that are now on the allow-list, and adding clears the request', async () => {
  await store.recordRequest('a@b.com', NOW);
  await store.recordRequest('c@d.com', NOW);
  await store.addAllowed('a@b.com');
  assert.deepEqual((await store.listPending()).map((r) => r.email), ['c@d.com']);
  assert.equal((await pool!.query('SELECT 1 FROM access_requests WHERE email = $1', ['a@b.com'])).rowCount, 0);
});

t('a session token is random, long and different each time', async () => {
  const a = await store.createSession('a@b.com', NOW);
  const b = await store.createSession('a@b.com', NOW);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/); // 32 random bytes
  assert.notEqual(a.token, b.token);
  assert.equal(a.expires_at.toISOString(), days(SESSION_DAYS).toISOString());
});

t('only the hash of the token is stored, never the token', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  const { rows } = await pool!.query('SELECT * FROM sessions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(token));
});

t('a session finds its email until it expires', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  assert.deepEqual(await store.findSession(token, days(1)), { email: 'a@b.com', expires_at: days(1 + SESSION_DAYS), account_id: null, account_ref: null });
  assert.equal(await store.findSession('not-a-token', NOW), null);
  assert.equal(await store.findSession('', NOW), null);
});

t('a session is gone once it has expired, and its row is deleted', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  assert.equal(await store.findSession(token, days(SESSION_DAYS + 1)), null);
  assert.equal((await pool!.query('SELECT 1 FROM sessions')).rowCount, 0);
});

t('Scenario: Sliding expiry - a session used 10 days after it was issued now expires 30 days from that use', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  const used = await store.findSession(token, days(10));
  assert.equal(used!.expires_at.toISOString(), days(10 + SESSION_DAYS).toISOString());
  const stored = (await pool!.query('SELECT expires_at FROM sessions')).rows[0].expires_at as Date;
  assert.equal(stored.toISOString(), days(10 + SESSION_DAYS).toISOString());
});

t('the expiry moves at most once a day', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  await store.findSession(token, new Date(NOW.getTime() + 3_600_000)); // an hour later
  const stored = (await pool!.query('SELECT expires_at FROM sessions')).rows[0].expires_at as Date;
  assert.equal(stored.toISOString(), days(SESSION_DAYS).toISOString()); // unchanged
});

t('Scenario: Sign out on the server - the session row is gone and the token finds nothing', async () => {
  const { token } = await store.createSession('a@b.com', NOW);
  await store.deleteSession(token);
  assert.equal(await store.findSession(token, NOW), null);
  assert.equal((await pool!.query('SELECT 1 FROM sessions')).rowCount, 0);
  await store.deleteSession(token); // already gone: no error
  await store.deleteSession('never-existed');
});

t('issuing a session clears out sessions that have expired, for everyone', async () => {
  await store.createSession('old@b.com', days(-60));
  await store.createSession('new@b.com', NOW);
  const { rows } = await pool!.query('SELECT email FROM sessions');
  assert.deepEqual(rows.map((r) => r.email), ['new@b.com']);
});

t('a session does not depend on the allow-list: removal is checked by the caller on each request', async () => {
  await store.addAllowed('a@b.com');
  const { token } = await store.createSession('a@b.com', NOW);
  await store.removeAllowed('a@b.com');
  assert.equal((await store.findSession(token, NOW))?.email, 'a@b.com');
  assert.equal(await store.isAllowed('a@b.com'), false);
});
