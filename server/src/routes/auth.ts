import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppleRevoker, AppleVerifier } from '../appleAuth.ts';
import { InvalidTokenError, MAX_TOKEN_CHARS, normalizeEmail, TokenServiceUnavailableError, type TokenVerifier } from '../auth.ts';
import type { AccountStore, SyncLimits } from '../accounts.ts';
import type { AuthStore } from '../authStore.ts';
import type { LeaderboardStore } from '../leaderboard.ts';
import { createHash } from 'node:crypto';
import type { DeletionLog } from '../deletionLog.ts';
import { createRateLimiter, type RateLimiter } from '../rateLimit.ts';
import type { MessageLimits } from '../messages.ts';
import { registerMessageRoutes } from './messages.ts';
import type { CourseReads } from '../courses/reads.ts';
import type { createCourseSettings } from '../courses/settings.ts';
import type { CourseStarts } from '../courses/starts.ts';
import type { CourseActivity } from '../courses/activity.ts';
import { registerCourseActivityRoutes, registerCourseRoutes, registerCourseStartRoutes } from './courses.ts';
import { registerMeRoutes } from './me.ts';
import { registerSocialRoutes } from './social.ts';
import { normalizeDeviceId } from './verifications.ts';

/** Per address, across everyone behind it: testers on one wifi share it. */
export const SIGN_INS_PER_HOUR_PER_IP = 30;
export const SIGN_INS_PER_HOUR_PER_EMAIL = 10;
export const SKIP_REQUESTS_PER_HOUR = 600;
export const READERS_PER_HOUR = 120;
export const REPORTS_PER_DAY = 10;
const MAX_BODY_BYTES = 8192;

export interface AuthDeps {
  verify: TokenVerifier;
  /** Left out, POST /auth/apple does not exist. */
  verifyApple?: AppleVerifier;
  /** Revokes a reader's Apple access when their account is deleted. Left out, nothing is revoked (and that is logged). */
  revokeApple?: AppleRevoker;
  /** Where the API says what went wrong without naming anyone. The default is one JSON line on the console. */
  log?: (event: Record<string, unknown>) => void;
  store: AuthStore;
  /** Left out, no accounts are made (older tests and builds); with it, an approved sign-in makes or finds the account. */
  accounts?: AccountStore;
  /** Plan 16 courses; left out, the /courses routes do not exist. */
  courses?: { reads: CourseReads; starts: CourseStarts; activity: CourseActivity; settings: ReturnType<typeof createCourseSettings> };
  /** How many message requests and messages a reader may send a day; the defaults are 5 and 20. */
  messageLimits?: MessageLimits;
  /** Looks at readers and cards per account; the default is 120 an hour. */
  readersLimiter?: RateLimiter;
  /** New reports per account; the default is 10 a day. */
  reportsLimiter?: RateLimiter;
  /** Where the hash of each deleted account is written. Left out, nothing is written. */
  deletionLog?: DeletionLog;
  /** Limits for POST /me/sync; the defaults are 200 changes a request and 500 saved articles. */
  syncLimits?: SyncLimits;
  /** Requests to POST /me/skips per account; the default is 600 an hour. */
  skipLimiter?: RateLimiter;
  /** Where the leaderboard entries of a deleted account are removed from. */
  leaderboard: LeaderboardStore;
  ipLimiter: RateLimiter;
  emailLimiter: RateLimiter;
  /**
   * ALLOW_ANY_GOOGLE_ACCOUNT, for a demo: any verified Google account counts as approved and the allow-list is not looked at.
   * Off unless asked for. An email Google has not verified is still never approved.
   */
  allowAnyAccount?: boolean;
}

/** The token in "Authorization: Bearer <token>", or undefined. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1];
}

/**
 * POST /auth/google, GET /auth/session and POST /auth/signout. The server decides who is approved: it checks Google's
 * token itself and looks the verified email up on the allow-list. A reader who is not approved gets the same answer
 * whatever the reason, and no session. Nothing here is cached.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps, now: () => Date) {
  app.addHook('onSend', async (request, reply) => {
    const u = request.url;
    if (u.startsWith('/auth/') || u.startsWith('/me/') || u === '/courses' || u.startsWith('/courses/') || u.startsWith('/concepts/') || u.startsWith('/readers/') || /^\/articles\/[^/?]+\/readers/.test(u)) reply.header('Cache-Control', 'no-store');
  });

  const approved = async (email: string) => deps.allowAnyAccount === true || (await deps.store.isAllowed(email));

  if (deps.accounts) {
    registerSocialRoutes(app, {
      store: deps.store,
      accounts: deps.accounts,
      approved,
      readersLimiter: deps.readersLimiter ?? createRateLimiter({ max: READERS_PER_HOUR, windowMs: 60 * 60_000 }),
      reportsLimiter: deps.reportsLimiter ?? createRateLimiter({ max: REPORTS_PER_DAY, windowMs: 24 * 60 * 60_000 }),
      now,
    });
  }
  if (deps.accounts && deps.courses) {
    const courseDeps = { store: deps.store, approved, reads: deps.courses.reads, starts: deps.courses.starts, activity: deps.courses.activity, settings: deps.courses.settings, now, log: deps.log };
    registerCourseRoutes(app, courseDeps);
    registerCourseStartRoutes(app, courseDeps);
    registerCourseActivityRoutes(app, courseDeps);
  }
  if (deps.accounts) registerMessageRoutes(app, { store: deps.store, accounts: deps.accounts, approved, limits: deps.messageLimits ?? {}, now });
  if (deps.accounts) registerMeRoutes(app, { store: deps.store, accounts: deps.accounts, approved, syncLimits: deps.syncLimits, skipLimiter: deps.skipLimiter ?? createRateLimiter({ max: SKIP_REQUESTS_PER_HOUR, windowMs: 60 * 60_000 }), now });

  type Identity = { email: string; email_verified: boolean; sub: string };
  const MESSAGE_UNAVAILABLE = { error: 'sign-in unavailable' };

  /** What follows a verified token from either provider: limits, the email, approval, the account and the session. */
  const completeSignIn = async (reply: FastifyReply, identity: Identity, provider: 'google' | 'apple') => {
    const email = normalizeEmail(identity.email);
    if (email === null) return reply.code(401).send({ error: 'invalid token' });
    if (!deps.emailLimiter.take(email)) return reply.code(429).send({ error: 'too many sign-ins; try again later' });

    try {
      // An address the provider has not verified proves nothing, so it is never approved and never recorded.
      if (!identity.email_verified) return { status: 'pending' };
      // A banned account is told nothing but "not approved", even when the app is open to any account.
      if (deps.accounts && (await deps.accounts.isBanned(identity.sub, provider))) return { status: 'pending' };
      if (!(await approved(email))) {
        await deps.store.recordRequest(email, now());
        return { status: 'pending' };
      }
      const account = deps.accounts ? await (provider === 'apple' ? deps.accounts.upsertApple({ sub: identity.sub, email }) : deps.accounts.upsert({ sub: identity.sub, email })) : null;
      const session = await deps.store.createSession(email, now(), account?.id);
      return { status: 'approved', session_token: session.token, expires_at: session.expires_at.toISOString(), ...(account ? { account_ref: account.ref } : {}) };
    } catch {
      return reply.code(503).send(MESSAGE_UNAVAILABLE); // never echo database details
    }
  };

  app.post('/auth/google', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const body = request.body;
    const idToken = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).id_token : undefined;
    if (typeof idToken !== 'string' || idToken === '' || idToken.length > MAX_TOKEN_CHARS) return reply.code(400).send({ error: 'id_token is required' });
    // Per address before the token is looked at, so a flood of bad tokens is stopped too.
    if (!deps.ipLimiter.take(request.ip || 'unknown')) return reply.code(429).send({ error: 'too many sign-ins; try again later' });

    let identity;
    try {
      identity = await deps.verify(idToken);
    } catch (error) {
      if (error instanceof InvalidTokenError) return reply.code(401).send({ error: 'invalid token' });
      return reply.code(503).send(MESSAGE_UNAVAILABLE); // Google unreachable, or anything unexpected: never "approved"
    }
    return completeSignIn(reply, identity, 'google');
  });

  if (deps.verifyApple) {
    const verifyApple = deps.verifyApple;
    app.post('/auth/apple', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
      const body = request.body;
      const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const { identity_token: token, nonce } = fields;
      if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_CHARS) return reply.code(400).send({ error: 'identity_token is required' });
      if (typeof nonce !== 'string' || nonce === '' || nonce.length > 256) return reply.code(400).send({ error: 'nonce is required' });
      if (!deps.ipLimiter.take(request.ip || 'unknown')) return reply.code(429).send({ error: 'too many sign-ins; try again later' });

      let identity;
      try {
        identity = await verifyApple(token, nonce);
      } catch (error) {
        if (error instanceof InvalidTokenError) return reply.code(401).send({ error: 'invalid token' });
        return reply.code(503).send(MESSAGE_UNAVAILABLE);
      }
      return completeSignIn(reply, identity, 'apple');
    });
  }

  app.get('/auth/session', async (request, reply) => {
    const token = bearerToken(request);
    try {
      const session = token === undefined ? null : await deps.store.findSession(token, now());
      if (!session) return reply.code(401).send({ error: 'not signed in' }); // the same whether there was no token, an unknown one or an expired one
      // The list is checked on every request, so removing an email stops it at once.
      if (!(await approved(session.email))) return reply.code(403).send({ status: 'pending' });
      return { status: 'approved', expires_at: session.expires_at.toISOString(), ...(session.account_ref ? { account_ref: session.account_ref } : {}) };
    } catch {
      return reply.code(503).send({ error: 'sign-in unavailable' });
    }
  });

  app.post('/auth/signout', async (request, reply) => {
    const token = bearerToken(request);
    try {
      if (token !== undefined) await deps.store.deleteSession(token);
    } catch {
      return reply.code(503).send({ error: 'sign-out unavailable' });
    }
    return reply.code(204).send();
  });

  /**
   * Deletes the signed-in reader's data. With an account: everything under it (profile, saved and verified articles, skip
   * counts, claimed devices and the old leaderboard rows of those devices). A `device_id` in the body, optional, also
   * deletes that device's old leaderboard rows: for apps from before accounts, and for installs never claimed. Then the
   * email's list entry, waiting request and sessions. The hash of the account's sub is written to the deletion log first,
   * so an account that is deleted is always on it. Sessions go last in effect, so after a failure the same call finishes
   * the job. The session must be valid, but the email need not still be approved.
   */
  app.post('/auth/delete-account', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const token = bearerToken(request);
    try {
      const session = token === undefined ? null : await deps.store.findSession(token, now());
      if (!session) return reply.code(401).send({ error: 'not signed in' });
      const body = request.body;
      if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) return reply.code(400).send({ error: 'device_id must be a UUID' });
      const given = body !== undefined && 'device_id' in body ? normalizeDeviceId((body as Record<string, unknown>).device_id) : undefined;
      const appleCode = body !== undefined && 'apple_authorization_code' in body ? (body as Record<string, unknown>).apple_authorization_code : undefined;
      if (given === null) return reply.code(400).send({ error: 'device_id must be a UUID' });

      const devices = new Set<string>(given ? [given] : []);
      const info = session.account_id && deps.accounts ? await deps.accounts.forDeletion(session.account_id) : null;
      for (const device of info?.devices ?? []) devices.add(device);
      if (info?.provider === 'apple') {
        // Apple asks that its access be revoked with the account. The reader signs in with Apple again for the one-time code; nothing of Apple's is kept. The deletion goes ahead whatever happens here.
        const failure = typeof appleCode !== 'string' || appleCode === '' || appleCode.length > 2048 ? 'no_code' : !deps.revokeApple ? 'not_configured' : (await deps.revokeApple(appleCode, info.sub)) === 'revoked' ? null : 'refused';
        if (failure) (deps.log ?? ((event) => console.log(JSON.stringify(event))))({ event: 'apple_revoke_failed', reason: failure });
      }
      if (info && deps.deletionLog) await deps.deletionLog.record(createHash('sha256').update(info.sub).digest('hex'), now());
      for (const device of devices) await deps.leaderboard.deleteDevice(device);
      if (session.account_id && deps.accounts) await deps.accounts.deleteAccount(session.account_id);
      // The email's list place, waiting request and sessions go with the account, unless another account (a Google and an Apple one can share an email) still uses it. This account's own sessions went with it.
      if (!info?.emailShared) await deps.store.deleteAccount(session.email);
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: 'account deletion unavailable' }); // never echo database details
    }
  });
}
