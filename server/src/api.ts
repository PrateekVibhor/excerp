import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config.ts';
import { createAccountStore, type AccountStore, type SyncLimits } from './accounts.ts';
import { createAppleRevoker, createAppleVerifier } from './appleAuth.ts';
import { createGoogleVerifier } from './auth.ts';
import { createFileDeletionLog, type DeletionLog } from './deletionLog.ts';
import { purgeExpired } from './messageExpiry.ts';
import type { MessageLimits } from './messages.ts';
import { createAuthStore } from './authStore.ts';
import { createArticleReader, createDb, type ArticleReader, type Db } from './db.ts';
import { createCourseActivity, type CourseActivity } from './courses/activity.ts';
import { createCourseReads, type CourseReads } from './courses/reads.ts';
import { runCourseCleanup } from './courses/retention.ts';
import { createCourseSettings } from './courses/settings.ts';
import { createCourseStarts, type CourseStarts } from './courses/starts.ts';
import { createLeaderboardStore, type LeaderboardStore } from './leaderboard.ts';
import { createRateLimiter, type RateLimiter } from './rateLimit.ts';
import { registerAuthRoutes, SIGN_INS_PER_HOUR_PER_EMAIL, SIGN_INS_PER_HOUR_PER_IP, type AuthDeps } from './routes/auth.ts';
import { registerLeaderboardRoute } from './routes/leaderboard.ts';
import { POSTS_PER_HOUR, POSTS_PER_HOUR_PER_IP, registerVerificationRoutes } from './routes/verifications.ts';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export interface ApiDeps {
  ping: Db['ping'];
  articles: ArticleReader;
  leaderboard: LeaderboardStore;
  /** Sign-in. Left out, the /auth routes do not exist (Google sign-in is off). Limits default to 30 an hour per address and 10 per email. */
  auth?: Pick<AuthDeps, 'verify' | 'store'> & Partial<Pick<AuthDeps, 'ipLimiter' | 'emailLimiter' | 'allowAnyAccount' | 'verifyApple' | 'revokeApple' | 'log'>>;
  /** Accounts, and the data tied to them. Left out, sign-in makes no accounts and the /me routes do not exist. */
  accounts?: AccountStore;
  /** Plan 16 courses. Left out, the /courses routes do not exist. */
  courses?: { reads: CourseReads; starts: CourseStarts; activity: CourseActivity; settings: ReturnType<typeof createCourseSettings> };
  /** Test hook: smaller limits for POST /me/sync. */
  syncLimits?: SyncLimits;
  /** Test hook: smaller daily limits on message requests and messages. */
  messageLimits?: MessageLimits;
  /** Test hooks: how many looks at readers an account may make an hour, and reports a day. */
  readersLimiter?: RateLimiter;
  reportsLimiter?: RateLimiter;
  /** Where the hash of each deleted account is written (outside the database). */
  deletionLog?: DeletionLog;
  /** Test hook: how many POST /me/skips requests an account may make an hour. */
  skipLimiter?: RateLimiter;
  /** At most 60 verifications per device per hour unless a test says otherwise. */
  limiter?: RateLimiter;
  /** At most 120 verifications per address per hour unless a test says otherwise. */
  ipLimiter?: RateLimiter;
  now?: () => Date;
  /** Addresses of the proxy in front of the API (Caddy). Only a request from one of them has its X-Forwarded-For believed. */
  trustProxy?: string[];
}

/** Reads ?limit=: missing means the default, above the maximum is capped, anything else invalid is null. */
export function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

/** Builds the API: the feed and articles are read-only; verifications are the one write. Dependencies are passed in so tests can use fakes. */
export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: deps.trustProxy?.length ? deps.trustProxy : false });
  await app.register(cors, { origin: true, methods: ['GET', 'POST'] });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.ping();
      return { status: 'ok' };
    } catch {
      // Say only that the database is unreachable; never echo connection details.
      return reply.code(503).send({ status: 'unavailable', reason: 'database unreachable' });
    }
  });

  // The app also sends ?user_id=; the feed is not personal in v1, so it is ignored.
  app.get<{ Querystring: { limit?: string } }>('/feed', async (request, reply) => {
    const limit = parseLimit(request.query.limit);
    if (limit === null) return reply.code(400).send({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
    try {
      return await deps.articles.feed(limit);
    } catch {
      return reply.code(503).send({ error: 'feed unavailable' });
    }
  });

  app.get<{ Params: { id: string } }>('/articles/:id', async (request, reply) => {
    try {
      const article = await deps.articles.getById(request.params.id);
      if (!article) return reply.code(404).send({ error: 'article not found' });
      return article;
    } catch {
      return reply.code(503).send({ error: 'article unavailable' });
    }
  });

  registerVerificationRoutes(app, {
    leaderboard: deps.leaderboard,
    limiter: deps.limiter ?? createRateLimiter({ max: POSTS_PER_HOUR, windowMs: 60 * 60_000 }),
    ipLimiter: deps.ipLimiter ?? createRateLimiter({ max: POSTS_PER_HOUR_PER_IP, windowMs: 60 * 60_000 }),
    now: deps.now ?? (() => new Date()),
  });
  registerLeaderboardRoute(app, {
    leaderboard: deps.leaderboard,
    accountForToken: deps.auth ? async (token) => (await deps.auth!.store.findSession(token, (deps.now ?? (() => new Date()))()))?.account_id ?? null : undefined,
  });
  if (deps.auth) {
    registerAuthRoutes(
      app,
      {
        verify: deps.auth.verify,
        verifyApple: deps.auth.verifyApple,
        revokeApple: deps.auth.revokeApple,
        log: deps.auth.log,
        store: deps.auth.store,
        accounts: deps.accounts,
        courses: deps.courses,
        syncLimits: deps.syncLimits,
        skipLimiter: deps.skipLimiter,
        deletionLog: deps.deletionLog,
        readersLimiter: deps.readersLimiter,
        messageLimits: deps.messageLimits,
        reportsLimiter: deps.reportsLimiter,
        leaderboard: deps.leaderboard,
        allowAnyAccount: deps.auth.allowAnyAccount,
        ipLimiter: deps.auth.ipLimiter ?? createRateLimiter({ max: SIGN_INS_PER_HOUR_PER_IP, windowMs: 60 * 60_000 }),
        emailLimiter: deps.auth.emailLimiter ?? createRateLimiter({ max: SIGN_INS_PER_HOUR_PER_EMAIL, windowMs: 60 * 60_000 }),
      },
      deps.now ?? (() => new Date()),
    );
  }

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const accounts = createAccountStore(db.pool);
  let deletionLog: DeletionLog | undefined;
  if (config.deletionLogPath) {
    const file = createFileDeletionLog(config.deletionLogPath);
    const dropped = await file.prune(new Date());
    if (dropped > 0) console.log(`Deletion log: ${dropped} old line(s) dropped`);
    deletionLog = file;
  } else {
    console.log('Deleted accounts are not written to a log: DELETION_LOG_PATH is not set');
  }
  // Sign in with Apple needs no secret to check a token (Apple's public keys and our bundle id). Revoking on deletion needs the team id, key id and key, which come only from the environment.
  const appleKey = config.applePrivateKey ?? (config.applePrivateKeyPath ? readFileSync(config.applePrivateKeyPath, 'utf8') : undefined);
  const revokeApple = config.appleTeamId && config.appleKeyId && appleKey ? createAppleRevoker({ teamId: config.appleTeamId, keyId: config.appleKeyId, privateKey: appleKey, clientId: config.appleBundleId }) : undefined;
  const auth = config.googleWebClientId ? { verify: createGoogleVerifier({ clientId: config.googleWebClientId }), verifyApple: createAppleVerifier({ audience: config.appleBundleId }), revokeApple, store: createAuthStore(db.pool), allowAnyAccount: config.allowAnyGoogleAccount } : undefined;
  if (auth && !revokeApple) console.log('Apple access is not revoked when an account is deleted: APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (or APPLE_PRIVATE_KEY_PATH) are not all set');
  if (!auth) console.log('Google sign-in is off: GOOGLE_WEB_CLIENT_ID is not set');
  else if (config.allowAnyGoogleAccount) console.log('Open access: any verified Google account is approved and the allow-list is not enforced (ALLOW_ANY_GOOGLE_ACCOUNT)');
  // Courses (Plan 16) exist but are off until the 'courses_off' setting is switched on; with the tables not yet migrated they answer 503.
  const courseSettings = createCourseSettings(db.pool);
  const courseReads = createCourseReads(db.pool);
  const courses = { reads: courseReads, settings: courseSettings, starts: createCourseStarts(db.pool, courseSettings), activity: createCourseActivity(db.pool, courseReads, courseSettings) };
  const app = await buildApi({ ping: db.ping, articles: createArticleReader(db.pool), leaderboard: createLeaderboardStore(db.pool), trustProxy: config.trustProxy, auth, accounts, deletionLog, courses });
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`API listening on port ${config.port}`);
  // The time limits (requests after 30 days, messages after 12 months, handled reports after 90 days) are kept true by a clean-up
  // that runs at start, which matters because the VM is often off, and then every six hours.
  const tidy = () =>
    purgeExpired(db.pool, new Date())
      .then((r) => {
        if (r.expiredRequests + r.deletedMessages + r.deletedConversations + r.deletedReports > 0) console.log(`Clean-up: ${JSON.stringify(r)}`);
      })
      .catch(() => console.error('The clean-up of old messages failed; it will be tried again.'));
  const tidyCourses = () =>
    runCourseCleanup(db.pool, courseSettings, new Date())
      .then((r) => {
        if (r.expiredAttempts + r.deletedFlags + r.deletedRequests > 0) console.log(`Course clean-up: ${JSON.stringify(r)}`);
      })
      .catch(() => console.error('The clean-up of course data failed; it will be tried again.'));
  void tidy();
  void tidyCourses();
  const tidyTimer = setInterval(() => {
    void tidy();
    void tidyCourses();
  }, 6 * 3_600_000);
  tidyTimer.unref();
  const shutdown = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
