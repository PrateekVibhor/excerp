// POST /auth/delete-account through the real API and the real SQL, in a throwaway schema. Skipped when no database is reachable.
// What it must remove is what the privacy policy's "Delete your Excerp account" section promises: the email and its
// sessions, the place on the approved or waiting list, and the leaderboard entries. Nothing of anyone else.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createAccountStore } from './accounts.ts';
import { buildApi } from './api.ts';
import type { TokenVerifier } from './auth.ts';
import { createAuthStore, type AuthStore } from './authStore.ts';
import { createArticleReader, createArticleStore } from './db.ts';
import { createLeaderboardStore } from './leaderboard.ts';
import { createRateLimiter } from './rateLimit.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `acctdel_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let store: AuthStore;
let skip: string | false = false;
let app: Awaited<ReturnType<typeof buildApi>>;
let clock = new Date('2026-10-09T12:00:00.000Z');
const articles: string[] = [];

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const verify: TokenVerifier = async (idToken) => ({ email: idToken, email_verified: true, sub: `sub-${idToken}` });
const deleted: Array<{ hash: string; at: Date }> = [];
const device = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
  const articleStore = createArticleStore(pool);
  for (let n = 1; n <= 2; n++) {
    await articleStore.insert({
      source_company: 'Google', source_url: `https://blog.google/acctdel-${n}`, content_type: 'Release', title: `Post ${n}`,
      summary: Array.from({ length: 55 }, (_, i) => `w${i}`).join(' '), published_at: '2026-09-01T00:00:00.000Z', fetched_at: '2026-10-04T12:00:00.000Z', reader_count: 0,
    });
    articles.push((await pool.query('SELECT id FROM articles WHERE source_url = $1', [`https://blog.google/acctdel-${n}`])).rows[0].id);
  }
  app = await buildApi({
    ping: async () => {},
    articles: createArticleReader(pool),
    leaderboard: createLeaderboardStore(pool),
    accounts: createAccountStore(pool),
    deletionLog: { record: async (hash: string, at: Date) => void deleted.push({ hash, at }) },
    auth: { verify, store, ipLimiter: createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }), emailLimiter: createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }) },
    ipLimiter: createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
    now: () => clock,
  });
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
    await pool!.query('TRUNCATE allowed_emails, access_requests, sessions, verifications, players');
    clock = new Date('2026-10-09T12:00:00.000Z');
    await fn();
  });

const rows = async (sql: string, args: unknown[] = []) => (await pool!.query(sql, args)).rows;
const sessionFor = async (email: string) => (await store.createSession(email, clock)).token;
const verified = (n: number, article: number, name: string) => createLeaderboardStore(pool!).record({ device_id: device(n), display_name: name, article_id: articles[article], verified_at: '2026-10-09T11:00:00.000Z' }, clock);
const del = (token: string | undefined, payload: unknown = { device_id: device(1) }) =>
  app.inject({ method: 'POST', url: '/auth/delete-account', headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, payload: payload as object });

/** Two readers, each approved, signed in, and on the board. */
async function twoReaders() {
  await store.addAllowed(ME);
  await store.addAllowed(OTHER);
  await verified(1, 0, 'Maya Chen');
  await verified(1, 1, 'Maya Chen');
  await verified(2, 0, 'Sam Ortiz');
  return { mine: await sessionFor(ME), theirs: await sessionFor(OTHER) };
}

t('Scenario: Delete my account - the email, sessions, list entry and leaderboard entries are gone, and the answer is 204', async () => {
  const { mine } = await twoReaders();
  await sessionFor(ME); // a second sign-in on another phone
  const res = await del(mine);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal((await rows('SELECT 1 FROM sessions WHERE email = $1', [ME])).length, 0);
  assert.equal((await rows('SELECT 1 FROM allowed_emails WHERE email = $1', [ME])).length, 0);
  assert.equal((await rows('SELECT 1 FROM verifications WHERE device_id = $1', [device(1)])).length, 0);
  assert.equal((await rows('SELECT 1 FROM players WHERE device_id = $1', [device(1)])).length, 0);
});

t('Scenario: Waiting-list entry - a request for access under the same email is removed too', async () => {
  const { mine } = await twoReaders();
  await store.recordRequest(ME, clock);
  assert.equal((await del(mine)).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM access_requests WHERE email = $1', [ME])).length, 0);
});

t('Scenario: Nobody else is touched - another reader\'s session, list entry and leaderboard row stay', async () => {
  const { mine, theirs } = await twoReaders();
  await store.recordRequest('waiting@example.com', clock);
  await del(mine);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${theirs}` } })).statusCode, 200);
  assert.equal((await rows('SELECT 1 FROM allowed_emails WHERE email = $1', [OTHER])).length, 1);
  assert.equal((await rows('SELECT 1 FROM access_requests WHERE email = $1', ['waiting@example.com'])).length, 1);
  const board = (await app.inject({ method: 'GET', url: '/leaderboard' })).json();
  assert.deepEqual(board.rows.map((r: { display_name: string; count: number }) => [r.display_name, r.count]), [['Sam Ortiz', 1]]);
});

t('Scenario: The old session stops working at once', async () => {
  const { mine } = await twoReaders();
  await del(mine);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${mine}` } })).statusCode, 401);
});

t('Scenario: Not signed in - no token, a made-up token or an expired one is 401 and nothing is deleted', async () => {
  const { mine } = await twoReaders();
  clock = new Date(clock.getTime() + 31 * 86_400_000);
  for (const token of [undefined, 'made-up', mine]) assert.equal((await del(token)).statusCode, 401);
  assert.equal((await rows('SELECT 1 FROM verifications')).length, 3);
  assert.equal((await rows('SELECT 1 FROM allowed_emails')).length, 2);
});

t('Scenario: Bad device id - 400 and nothing is deleted, not even the email (a missing one is fine now: see "No device id" below)', async () => {
  const { mine } = await twoReaders();
  for (const payload of [{ device_id: 'nope' }, { device_id: 5 }, { device_id: null }]) assert.equal((await del(mine, payload)).statusCode, 400);
  assert.equal((await rows('SELECT 1 FROM sessions WHERE email = $1', [ME])).length, 1);
  assert.equal((await rows('SELECT 1 FROM verifications')).length, 3);
});

t('Scenario: Upper-case device id - matches the lower-case one the server stored', async () => {
  const { mine } = await twoReaders();
  assert.equal((await del(mine, { device_id: device(1).toUpperCase() })).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM verifications WHERE device_id = $1', [device(1)])).length, 0);
});

t('Scenario: No leaderboard entries - a reader who never passed a quiz can still delete', async () => {
  await store.addAllowed(ME);
  const mine = await sessionFor(ME);
  assert.equal((await del(mine, { device_id: device(9) })).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM allowed_emails')).length, 0);
});

t('Scenario: Removed from the list first - a session whose email is no longer approved can still delete', async () => {
  const { mine } = await twoReaders();
  await store.removeAllowed(ME);
  assert.equal((await del(mine)).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM verifications WHERE device_id = $1', [device(1)])).length, 0);
});

t('Scenario: Sent again after a failure - the second try finishes the job and is also 204', async () => {
  const { mine } = await twoReaders();
  await createLeaderboardStore(pool!).deleteDevice(device(1)); // the first try got this far, then the connection dropped
  assert.equal((await del(mine)).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM sessions WHERE email = $1', [ME])).length, 0);
});

t('Scenario: Database trouble - 503, no details, and the session still works so the reader can try again', async () => {
  const { mine } = await twoReaders();
  await pool!.query('ALTER TABLE players RENAME TO players_away');
  try {
    const res = await del(mine);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'account deletion unavailable' });
  } finally {
    await pool!.query('ALTER TABLE players_away RENAME TO players');
  }
  assert.equal((await rows('SELECT 1 FROM sessions WHERE email = $1', [ME])).length, 1);
});

// ---- Plan 14: accounts. A reader's whole account goes, with or without a device id. ----------------------

const tAccount = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await pool!.query('TRUNCATE allowed_emails, access_requests, sessions, verifications, players, accounts, account_reading_list, account_verifications, account_skips, device_claims CASCADE');
    clock = new Date('2026-10-10T12:00:00.000Z');
    deleted.length = 0;
    await fn();
  });
const signInHttp = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: email } });
  return { token: res.json().session_token as string, ref: res.json().account_ref as string };
};
const authed = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
const stamp = (m: number) => new Date(clock.getTime() + m * 60_000).toISOString();
const accountRows = async (email: string) =>
  (await rows(`SELECT (SELECT count(*) FROM account_reading_list l WHERE l.account_id = a.id)::int AS list, (SELECT count(*) FROM account_verifications v WHERE v.account_id = a.id)::int AS verified,
                      (SELECT count(*) FROM account_skips k WHERE k.account_id = a.id)::int AS skips, (SELECT count(*) FROM device_claims c WHERE c.account_id = a.id)::int AS claims
               FROM accounts a WHERE a.email = $1`, [email]))[0];

/** A reader with everything: a profile, a saved article, a badge, skips, and an old device claimed. */
async function everything(email: string, deviceNumber: number, name: string) {
  await store.addAllowed(email);
  await app.inject({ method: 'POST', url: '/verifications', payload: { device_id: device(deviceNumber), display_name: name, article_id: articles[1], verified_at: stamp(-30) } });
  const { token, ref } = await signInHttp(email);
  await authed(token, 'POST', '/me/sync', { cursor: 0, changes: {
    profile: { display_name: name, industry: 'Software', interests: ['Cloud'], updated_at: stamp(-20) },
    reading_list: [{ article_id: articles[0], saved_at: stamp(-10), removed: false, updated_at: stamp(-10) }],
    verified: [{ article_id: articles[0], verified_at: stamp(-9), topic: 'Cloud' }],
  } });
  await authed(token, 'POST', '/me/skips', { article_ids: [articles[0], articles[1]] });
  await authed(token, 'POST', '/me/claim-device', { device_id: device(deviceNumber) });
  return { token, ref };
}

tAccount('Scenario: Delete the account - the account and everything under it goes: profile, saved articles, badges, skips, the claimed device and its old leaderboard rows, sessions and the list entry; no device id needed', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  await signInHttp(ME); // a second phone
  assert.deepEqual(await accountRows(ME), { list: 1, verified: 2, skips: 2, claims: 1 });
  const res = await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  assert.equal(res.statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM accounts WHERE email = $1', [ME])).length, 0);
  for (const table of ['account_reading_list', 'account_verifications', 'account_skips', 'device_claims', 'sessions', 'allowed_emails', 'players', 'verifications']) {
    assert.equal((await rows(`SELECT 1 FROM ${table}`)).length, 0, `${table} is empty`); // this reader is the only one in the database
  }
  const board = (await app.inject({ method: 'GET', url: '/leaderboard' })).json();
  assert.deepEqual(board.rows, []);
});

tAccount('Scenario: Nobody else is touched - another account\'s data, claims and rows all stay', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  await everything(OTHER, 2, 'Sam Ortiz');
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  assert.deepEqual(await accountRows(OTHER), { list: 1, verified: 2, skips: 2, claims: 1 });
  assert.equal((await rows('SELECT 1 FROM device_claims WHERE device_id = $1', [device(2)])).length, 1); // its claim stays (its old rows were folded into the account when it was claimed)
});

tAccount('Scenario: The deletion log - exactly one record, the SHA-256 of the sub and the time, never the sub, the email or the name', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].hash, createHash('sha256').update(`sub-${ME}`).digest('hex'));
  assert.deepEqual(deleted[0].at, clock);
  const text = JSON.stringify(deleted);
  for (const secret of [ME, 'sub-me', 'Maya']) assert.ok(!text.includes(secret), secret);
});

tAccount('Scenario: No device id - an account is deleted without one; a reader with no account at all (an older session) is also deleted by the device id', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  assert.equal((await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` }, payload: {} })).statusCode, 204);
  // An older session has no account; the old call, with a device id, still works.
  await store.addAllowed(OTHER);
  await verified(3, 0, 'Old Timer');
  const legacy = await sessionFor(OTHER);
  assert.equal((await del(legacy, { device_id: device(3) })).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM players WHERE device_id = $1', [device(3)])).length, 0);
});

tAccount('Scenario: A device id that was never claimed is deleted along with the account when the app sends it', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  await verified(4, 1, 'Another Phone'); // this reader\'s other, unclaimed install
  assert.equal((await del(me.token, { device_id: device(4) })).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM players WHERE device_id = $1', [device(4)])).length, 0);
});

tAccount('Scenario: Signing in again afterwards - a brand-new, empty account with a different id', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  const [{ id: oldId }] = await rows('SELECT id FROM accounts WHERE email = $1', [ME]);
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  await store.addAllowed(ME); // the list entry went with the account; on open access the reader is approved again
  const again = await signInHttp(ME);
  const [{ id: newId }] = await rows('SELECT id FROM accounts WHERE email = $1', [ME]);
  assert.notEqual(newId, oldId);
  assert.deepEqual(await accountRows(ME), { list: 0, verified: 0, skips: 0, claims: 0 });
  const pulled = (await authed(again.token, 'POST', '/me/sync', { cursor: 0, changes: {} })).json();
  assert.deepEqual(pulled.changes, { profile: null, reading_list: [], verified: [] });
});

tAccount('Scenario: Database trouble in the middle - 503, and the session still works, so pressing the button again finishes the job', async () => {
  const me = await everything(ME, 1, 'Maya Chen');
  await pool!.query('ALTER TABLE players RENAME TO players_away'); // the claimed device's old rows are removed along the way
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } })).statusCode, 503);
  } finally {
    await pool!.query('ALTER TABLE players_away RENAME TO players');
  }
  assert.equal((await authed(me.token, 'GET', '/auth/session')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } })).statusCode, 204);
  assert.equal((await rows('SELECT 1 FROM accounts WHERE email = $1', [ME])).length, 0);
});

// ---- Plan 15: readers, blocks and reports ------------------------------------------------------------

/** Makes a visible reader of article 0 through the real API, then returns its token. */
async function visibleReader(email: string, name: string) {
  await store.addAllowed(email);
  const { token } = await signInHttp(email);
  await authed(token, 'POST', '/me/sync', { cursor: 0, changes: {
    profile: { display_name: name, industry: 'Software', interests: ['Cloud'], updated_at: stamp(-5) },
    reading_list: [{ article_id: articles[0], saved_at: stamp(-5), removed: false, updated_at: stamp(-5) }],
  } });
  const on = await app.inject({ method: 'PUT', url: '/me/messaging-settings', headers: { authorization: `Bearer ${token}` }, payload: { discoverable: true, accepts_messages: true, confirm_adult: true, accept_terms: true } });
  assert.equal(on.statusCode, 200, on.body);
  const [{ public_id }] = await rows('SELECT public_id FROM accounts WHERE email = $1', [email]);
  return { token, publicId: public_id as string };
}
const readersOf = async (token: string) => ((await authed(token, 'GET', `/articles/${articles[0]}/readers`)).json().readers as Array<{ display_name: string }>).map((r) => r.display_name);

tAccount('Scenario: A deleted reader leaves every list at once, and their blocks go both ways', async () => {
  const me = await visibleReader(ME, 'Maya');
  const other = await visibleReader(OTHER, 'Sam');
  await authed(me.token, 'POST', '/me/blocks', { public_id: other.publicId });
  await authed(other.token, 'POST', '/me/blocks', { public_id: me.publicId });
  assert.equal((await rows('SELECT 1 FROM blocks')).length, 2);
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  assert.equal((await rows('SELECT 1 FROM blocks')).length, 0); // both directions, whoever made them
  assert.deepEqual(await readersOf(other.token), []);
  assert.equal((await authed(other.token, 'GET', `/readers/${me.publicId}`)).statusCode, 404);
});

tAccount('Scenario: Reports stay for the moderator when either side deletes their account - with the frozen copy, and no link to the person', async () => {
  const me = await visibleReader(ME, 'Maya');
  const other = await visibleReader(OTHER, 'Sam');
  const third = await visibleReader('third@example.com', 'Tess');
  assert.equal((await authed(me.token, 'POST', '/me/reports', { public_id: other.publicId, reason: 'spam' })).statusCode, 204);
  assert.equal((await authed(other.token, 'POST', '/me/reports', { public_id: third.publicId, reason: 'harassment' })).statusCode, 204);
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } }); // the reporter of the first
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${third.token}` } }); // the reported of the second
  const reports = await rows('SELECT reporter_id, reported_id, reason, snapshot FROM reports ORDER BY reason');
  assert.equal(reports.length, 2);
  const byReason = Object.fromEntries(reports.map((r) => [r.reason, r]));
  assert.equal(byReason.spam.reporter_id, null);
  assert.equal(byReason.spam.snapshot.display_name, 'Sam');
  assert.equal(byReason.harassment.reported_id, null);
  assert.equal(byReason.harassment.snapshot.display_name, 'Tess');
});

tAccount('Scenario: The switches and the public id go with the account, and signing in again starts hidden and unconfirmed', async () => {
  const me = await visibleReader(ME, 'Maya');
  await app.inject({ method: 'POST', url: '/auth/delete-account', headers: { authorization: `Bearer ${me.token}` } });
  assert.equal((await rows('SELECT 1 FROM accounts WHERE public_id = $1', [me.publicId])).length, 0);
  await store.addAllowed(ME);
  const again = await signInHttp(ME);
  const settings = (await authed(again.token, 'GET', '/me/messaging-settings')).json();
  assert.deepEqual(settings, { discoverable: false, accepts_messages: false, adult_confirmed: false, terms_accepted: false });
  const [{ public_id }] = await rows('SELECT public_id FROM accounts WHERE email = $1', [ME]);
  assert.notEqual(public_id, me.publicId); // a new, unrelated id
});

