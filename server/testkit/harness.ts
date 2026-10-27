// Shared setup for the account tests: a throwaway schema, the real API over the real SQL, a fake Google verifier that
// also gives a `sub`, a clock the tests move, and a sink that stands in for the deletion log file.
// Lives outside src/ so it is not part of the Docker image. Tests skip when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createAccountStore } from '../src/accounts.ts';
import { buildApi } from '../src/api.ts';
import { InvalidTokenError, TokenServiceUnavailableError, type TokenVerifier } from '../src/auth.ts';
import type { AppleRevoker, AppleVerifier } from '../src/appleAuth.ts';
import { createAuthStore, type AuthStore } from '../src/authStore.ts';
import { createArticleReader, createArticleStore } from '../src/db.ts';
import { createCourseActivity } from '../src/courses/activity.ts';
import { createCourseReads } from '../src/courses/reads.ts';
import { createCourseSettings } from '../src/courses/settings.ts';
import { createCourseStarts } from '../src/courses/starts.ts';
import { createLeaderboardStore } from '../src/leaderboard.ts';
import { createRateLimiter } from '../src/rateLimit.ts';

export const REF = /^EXC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** The people the tests sign in as. The Google token the app would send is just the key here. */
export const USERS = {
  alice: { sub: 'sub-alice', email: 'alice@example.com' },
  alice2: { sub: 'sub-alice', email: 'alice.new@example.com' }, // the same Google account after an email change
  bob: { sub: 'sub-bob', email: 'bob@example.com' },
  carol: { sub: 'sub-carol', email: 'carol@example.com' },
  dave: { sub: 'sub-dave', email: 'dave@example.com' },
  erin: { sub: 'sub-erin', email: 'erin@example.com' },
  frank: { sub: 'sub-frank', email: 'frank@example.com' },
  grace: { sub: 'sub-grace', email: 'grace@example.com' },
  heidi: { sub: 'sub-heidi', email: 'heidi@example.com' },
  ivan: { sub: 'sub-ivan', email: 'ivan@example.com' },
  stranger: { sub: 'sub-stranger', email: 'stranger@example.com' }, // never on the list
  unverified: { sub: 'sub-unverified', email: 'unverified@example.com', verified: false },
} as const;
export type UserKey = keyof typeof USERS;

/** The people who sign in with Apple. The identity token the app would send is just the key here; the nonce must be 'good-nonce'. */
export const APPLE_USERS = {
  ann: { sub: 'apple-ann', email: 'ann@example.com' },
  relay: { sub: 'apple-relay', email: 'x7k2q@privaterelay.appleid.com', private: true },
  aliceOnApple: { sub: 'apple-alice', email: 'alice@example.com' }, // the same real email as the Google test user alice
  unverifiedApple: { sub: 'apple-unverified', email: 'u@example.com', verified: false },
  down: { sub: 'x', email: 'x@example.com' }, // Apple's keys cannot be fetched
} as const;
export type AppleUserKey = keyof typeof APPLE_USERS;
export const GOOD_NONCE = 'good-nonce';

export interface BuildOptions {
  allowAny?: boolean;
  skipsPerHour?: number;
  maxReadingList?: number;
  maxChanges?: number;
  /** Requests to the readers endpoints an account may make an hour. */
  readersPerHour?: number;
  /** Reports an account may make a day. */
  reportsPerDay?: number;
  /** New message requests an account may send a day. */
  pitchesPerDay?: number;
  /** Messages (requests and replies) an account may send a day. */
  messagesPerDay?: number;
}

export function useHarness(prefix: string) {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  let pool: pg.Pool | undefined;
  let skip: string | false = false;
  let auth: AuthStore;
  const extra: Array<{ close(): Promise<unknown> }> = [];
  const h = {
    clock: { now: new Date('2026-10-10T12:00:00.000Z') },
    articles: [] as string[],
    deleted: [] as Array<{ hash: string; at: Date }>,
    /** The authorization codes the fake Apple was asked to revoke, what it answers, and what the API logged. */
    revoked: [] as string[],
    revokedFor: [] as string[],
    revokeAnswer: 'revoked' as 'revoked' | 'failed',
    logged: [] as Array<Record<string, unknown>>,
    app: undefined as unknown as Awaited<ReturnType<typeof buildApi>>,
    get pool() {
      return pool!;
    },
  };

  /** The course features, built over the test database and the test clock. */
  function courseDeps() {
    const settings = createCourseSettings(pool!);
    const reads = createCourseReads(pool!);
    return { reads, settings, starts: createCourseStarts(pool!, settings, () => h.clock.now), activity: createCourseActivity(pool!, reads, settings, () => h.clock.now) };
  }

  async function build(options: BuildOptions = {}) {
    const verify: TokenVerifier = async (idToken) => {
      const user = (USERS as Record<string, { sub: string; email: string; verified?: boolean }>)[idToken];
      if (!user) throw new InvalidTokenError('no such test user');
      return { email: user.email, email_verified: user.verified !== false, sub: user.sub };
    };
    const verifyApple: AppleVerifier = async (identityToken, nonce) => {
      const user = (APPLE_USERS as Record<string, { sub: string; email: string; private?: boolean; verified?: boolean }>)[identityToken];
      if (identityToken === 'down') throw new TokenServiceUnavailableError('no');
      if (!user || nonce !== GOOD_NONCE) throw new InvalidTokenError('no such test user');
      return { sub: user.sub, email: user.email, email_verified: user.verified !== false, is_private_email: user.private === true };
    };
    const revokeApple: AppleRevoker = async (code, expectedSub) => {
      h.revoked.push(code);
      h.revokedFor.push(expectedSub);
      return h.revokeAnswer;
    };
    const big = () => createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 });
    const app = await buildApi({
      ping: async () => {},
      articles: createArticleReader(pool!, () => h.clock.now),
      leaderboard: createLeaderboardStore(pool!),
      accounts: createAccountStore(pool!),
      courses: courseDeps(),
      deletionLog: { record: async (hash: string, at: Date) => void h.deleted.push({ hash, at }) },
      skipLimiter: createRateLimiter({ max: options.skipsPerHour ?? 1_000_000, windowMs: 3_600_000 }),
      syncLimits: { maxReadingList: options.maxReadingList, maxChanges: options.maxChanges },
      readersLimiter: createRateLimiter({ max: options.readersPerHour ?? 1_000_000, windowMs: 3_600_000 }),
      reportsLimiter: createRateLimiter({ max: options.reportsPerDay ?? 1_000_000, windowMs: 86_400_000 }),
      messageLimits: { pitchesPerDay: options.pitchesPerDay ?? 1_000_000, messagesPerDay: options.messagesPerDay ?? 1_000_000 },
      auth: { verify, verifyApple, revokeApple, log: (event) => void h.logged.push(event), store: auth, ipLimiter: big(), emailLimiter: big(), allowAnyAccount: options.allowAny },
      ipLimiter: big(),
      now: () => h.clock.now,
    });
    extra.push(app);
    return app;
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
    auth = createAuthStore(pool);
    const store = createArticleStore(pool);
    for (let n = 1; n <= 4; n++) {
      await store.insert({
        source_company: 'Google', source_url: `https://blog.google/${prefix}-${n}`, content_type: 'Release', title: `Post ${n}`,
        summary: Array.from({ length: 55 }, (_, i) => `w${i}`).join(' '), published_at: '2026-09-01T00:00:00.000Z', fetched_at: '2026-10-04T12:00:00.000Z', reader_count: 0,
      });
      h.articles.push((await pool.query('SELECT id FROM articles WHERE source_url = $1', [`https://blog.google/${prefix}-${n}`])).rows[0].id);
    }
    h.app = await build();
  });
  after(async () => {
    if (!pool) return;
    for (const app of extra) await app.close();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  /** A test that starts from an empty database (the four articles stay), the clock at its start, and alice, bob and carol on the allow-list. */
  const t = (name: string, fn: () => Promise<void>) =>
    test(name, async (ctx) => {
      if (skip) return ctx.skip(skip);
      // CASCADE also empties anything that points at an account (blocks, reports and so on), whether or not it exists yet.
      await pool!.query('TRUNCATE allowed_emails, access_requests, sessions, verifications, players, accounts, account_reading_list, account_verifications, account_skips, device_claims CASCADE');
      h.clock.now = new Date('2026-10-10T12:00:00.000Z');
      h.deleted.length = 0;
      h.revoked.length = 0;
      h.revokedFor.length = 0;
      h.logged.length = 0;
      h.revokeAnswer = 'revoked';
      for (const [key, user] of Object.entries(USERS)) if (key !== 'stranger' && key !== 'unverified') await auth.addAllowed(user.email);
      await fn();
    });

  /** Signs in with Google as a test user. Each call is a new session, so two calls are two phones on one account. */
  async function signIn(user: UserKey, app = h.app) {
    const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: user } });
    const body = res.json();
    return { res, body, token: body.session_token as string, ref: body.account_ref as string };
  }
  /** Signs in with Apple as a test user (the nonce is the right one unless a test gives another). */
  async function signInApple(user: AppleUserKey, app = h.app, nonce: string | undefined = GOOD_NONCE) {
    const res = await app.inject({ method: 'POST', url: '/auth/apple', payload: { identity_token: user, ...(nonce === undefined ? {} : { nonce }) } });
    const body = res.json();
    return { res, body, token: body.session_token as string, ref: body.account_ref as string };
  }
  const call = (token: string | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, app = h.app) =>
    app.inject({ method, url, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, payload: payload as object });
  const post = (token: string | undefined, url: string, payload?: unknown, app = h.app) => call(token, 'POST', url, payload, app);
  const sync = (token: string | undefined, cursor: unknown, changes: unknown = {}, app = h.app) => post(token, '/me/sync', { cursor, changes }, app);
  /** Everything the server holds for the session's account, in a fixed order, so two phones can be compared. */
  async function pull(token: string) {
    const res = await sync(token, 0);
    assert.equal(res.statusCode, 200);
    const { changes } = res.json();
    const by = (key: string) => (a: Record<string, string>, b: Record<string, string>) => a[key].localeCompare(b[key]);
    return { profile: changes.profile, reading_list: [...changes.reading_list].sort(by('article_id')), verified: [...changes.verified].sort(by('article_id')) };
  }
  const rows = async (sql: string, args: unknown[] = []) => (await pool!.query(sql, args)).rows;
  const put = (token: string | undefined, url: string, payload?: unknown, app = h.app) => call(token, 'PUT', url, payload, app);
  /** The id other readers see for this test user. */
  const publicId = async (user: UserKey): Promise<string> => (await rows('SELECT public_id FROM accounts WHERE email = $1', [USERS[user].email]))[0].public_id;
  const settings = (token: string | undefined, body: unknown) => put(token, '/me/messaging-settings', body);

  type Action = number | { article: number; minutesAgo?: number; removed?: boolean };
  /**
   * A signed-in test user with a profile, some saved and verified articles (by index into the four test articles), and,
   * unless told otherwise, visible to other readers. Made through the real API.
   */
  async function reader(
    user: UserKey,
    o: { name?: string; industry?: string; interests?: string[]; saved?: Action[]; verified?: Action[]; visible?: boolean; accepts?: boolean } = {},
  ) {
    const { token, ref } = await signIn(user);
    const norm = (a: Action) => (typeof a === 'number' ? { article: a } : a);
    const profile = { display_name: o.name ?? user, industry: o.industry ?? 'Software', interests: o.interests ?? ['Cloud'], updated_at: at(-1) };
    const reading_list = (o.saved ?? []).map(norm).map((a) => ({ article_id: h.articles[a.article], saved_at: at(-(a.minutesAgo ?? 5)), removed: a.removed === true, updated_at: at(-(a.minutesAgo ?? 5)) }));
    const verified = (o.verified ?? []).map(norm).map((a) => ({ article_id: h.articles[a.article], verified_at: at(-(a.minutesAgo ?? 5)), topic: 'Cloud' }));
    const res = await sync(token, 0, { profile, reading_list, verified });
    assert.equal(res.statusCode, 200, res.body);
    if (o.visible !== false) {
      const on = await settings(token, { discoverable: true, accepts_messages: o.accepts === true, confirm_adult: true, accept_terms: true });
      assert.equal(on.statusCode, 200, on.body);
    }
    return { token, ref, user };
  }
  const device = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = (minutes: number) => new Date(h.clock.now.getTime() + minutes * 60_000).toISOString();

  /** Moves the test clock forward by days and keeps every session alive across the jump, so a test can look at the far future as the same readers. */
  const advance = async (days: number) => {
    h.clock.now = new Date(h.clock.now.getTime() + days * 86_400_000);
    await pool!.query(`UPDATE sessions SET expires_at = expires_at + make_interval(days => $1::int)`, [days]);
  };

  /** A reader who can send and receive message requests: visible, takes messages, has verified an article. Made through the real API. */
  const member = (user: UserKey, o: Parameters<typeof reader>[1] = {}) => reader(user, { verified: [0], accepts: true, ...o });

  return Object.assign(h, { t, build, signIn, signInApple, call, post, put, sync, pull, rows, device, at, auth: () => auth, publicId, settings, reader, member, advance });
}
