import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { INDUSTRIES } from '../../../src/data/types.ts';
import { AccountGone, InvalidChange, type AccountStore, type ProfileChange, type ReadingListChange, type SyncChanges, type SyncLimits, type VerifiedChange } from '../accounts.ts';
import type { AuthStore } from '../authStore.ts';
import type { RateLimiter } from '../rateLimit.ts';
import { bearerToken } from './auth.ts';
import { ISO_DATE_TIME, normalizeDeviceId, UUID } from './verifications.ts';

const MAX_SYNC_BODY_BYTES = 65_536;
const NAME_MAX = 40;
const INTERESTS_MAX = 20;
/** Skips one request may report: the app sends them in batches. */
export const MAX_SKIPS_PER_REQUEST = 100;

export interface MeDeps {
  store: AuthStore;
  accounts: AccountStore;
  /** Whether this email may use the app right now (the allow-list is checked on every request). */
  approved: (email: string) => Promise<boolean>;
  syncLimits?: SyncLimits;
  /** Requests to /me/skips per account. */
  skipLimiter: RateLimiter;
  now: () => Date;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && ISO_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);
/** Trimmed text of 1 to 40 characters (as the database counts them) with no control characters, or null. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  const length = [...t].length;
  return length >= 1 && length <= NAME_MAX && !/\p{Cc}/u.test(t) ? t : null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function parseProfile(raw: unknown): Parsed<ProfileChange> {
  if (!isObject(raw)) return bad('profile must be an object');
  const display_name = text(raw.display_name);
  if (display_name === null) return bad(`profile.display_name must be 1 to ${NAME_MAX} characters`);
  if (typeof raw.industry !== 'string' || !(INDUSTRIES as readonly string[]).includes(raw.industry)) return bad('profile.industry is not one of the known industries');
  if (!Array.isArray(raw.interests) || raw.interests.length > INTERESTS_MAX) return bad(`profile.interests must be a list of at most ${INTERESTS_MAX}`);
  const interests: string[] = [];
  for (const item of raw.interests) {
    const t = text(item);
    if (t === null) return bad(`each interest must be 1 to ${NAME_MAX} characters`);
    interests.push(t);
  }
  if (!isTime(raw.updated_at)) return bad('profile.updated_at must be an ISO 8601 date and time');
  return { ok: true, value: { display_name, industry: raw.industry, interests, updated_at: raw.updated_at } };
}

function parseReadingList(raw: unknown): Parsed<ReadingListChange[]> {
  if (!Array.isArray(raw)) return bad('reading_list must be a list');
  const out: ReadingListChange[] = [];
  for (const item of raw) {
    const article_id = isObject(item) ? uuid(item.article_id) : null;
    if (!isObject(item) || article_id === null) return bad('reading_list.article_id must be the id of an article');
    if (!isTime(item.saved_at) || !isTime(item.updated_at)) return bad('reading_list times must be ISO 8601 dates and times');
    if (item.removed !== undefined && typeof item.removed !== 'boolean') return bad('reading_list.removed must be true or false');
    out.push({ article_id, saved_at: item.saved_at, removed: item.removed === true, updated_at: item.updated_at });
  }
  return { ok: true, value: out };
}

function parseVerified(raw: unknown): Parsed<VerifiedChange[]> {
  if (!Array.isArray(raw)) return bad('verified must be a list');
  const out: VerifiedChange[] = [];
  for (const item of raw) {
    const article_id = isObject(item) ? uuid(item.article_id) : null;
    if (!isObject(item) || article_id === null) return bad('verified.article_id must be the id of an article');
    if (!isTime(item.verified_at)) return bad('verified.verified_at must be an ISO 8601 date and time');
    const topic = text(item.topic);
    if (topic === null) return bad(`verified.topic must be 1 to ${NAME_MAX} characters`);
    out.push({ article_id, verified_at: item.verified_at, topic });
  }
  return { ok: true, value: out };
}

/** The body of POST /me/sync. Extra fields are ignored; everything that is stored is checked here. */
export function parseSync(body: unknown): Parsed<{ cursor: number; changes: SyncChanges }> {
  if (!isObject(body)) return bad('the body must be a JSON object');
  const cursor = body.cursor ?? 0;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) return bad('cursor must be a whole number, 0 or more');
  const raw = body.changes ?? {};
  if (!isObject(raw)) return bad('changes must be an object');
  const changes: SyncChanges = {};
  if (raw.profile !== undefined && raw.profile !== null) {
    const p = parseProfile(raw.profile);
    if (!p.ok) return p;
    changes.profile = p.value;
  }
  if (raw.reading_list !== undefined) {
    const l = parseReadingList(raw.reading_list);
    if (!l.ok) return l;
    changes.reading_list = l.value;
  }
  if (raw.verified !== undefined) {
    const v = parseVerified(raw.verified);
    if (!v.ok) return v;
    changes.verified = v.value;
  }
  return { ok: true, value: { cursor, changes } };
}

/** Who is calling: a signed-in, still-approved reader with an account, or the answer to send instead. */
export async function requireAccount(request: FastifyRequest, reply: FastifyReply, deps: Pick<MeDeps, 'store' | 'approved' | 'now'>): Promise<{ accountId: string; email: string } | null> {
  const token = bearerToken(request);
  const session = token === undefined ? null : await deps.store.findSession(token, deps.now());
  if (!session) {
    await reply.code(401).send({ error: 'not signed in' });
    return null;
  }
  if (!(await deps.approved(session.email))) {
    await reply.code(403).send({ status: 'pending' });
    return null;
  }
  if (!session.account_id) {
    await reply.code(401).send({ error: 'sign in again' }); // a session from before accounts: one new sign-in makes the account
    return null;
  }
  return { accountId: session.account_id, email: session.email };
}

/** Routes that need an account: /me/sync, /me/claim-device and /me/skips. */
export function registerMeRoutes(app: FastifyInstance, deps: MeDeps) {
  const fail = (reply: FastifyReply, error: unknown, what: string) => {
    if (error instanceof InvalidChange) return reply.code(400).send({ error: error.message });
    if (error instanceof AccountGone) return reply.code(401).send({ error: 'not signed in' });
    return reply.code(503).send({ error: `${what} unavailable` }); // never echo database details
  };

  app.post('/me/sync', { bodyLimit: MAX_SYNC_BODY_BYTES }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const parsed = parseSync(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      return await deps.accounts.sync(who.accountId, parsed.value.cursor, parsed.value.changes, deps.now(), deps.syncLimits);
    } catch (error) {
      return fail(reply, error, 'sync');
    }
  });

  app.post('/me/claim-device', { bodyLimit: 1024 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const device = normalizeDeviceId(isObject(request.body) ? request.body.device_id : undefined);
      if (device === null) return reply.code(400).send({ error: 'device_id must be a UUID' });
      const claimed = await deps.accounts.claimDevice(who.accountId, device);
      if (claimed === 'conflict') return reply.code(409).send({ error: 'that device already belongs to another account' });
      return claimed;
    } catch (error) {
      return fail(reply, error, 'claim');
    }
  });

  // Counted from sign-in, whether or not syncing has started. A counter per account and article: no time, device or session.
  app.post('/me/skips', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const raw = isObject(request.body) ? request.body.article_ids : undefined;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SKIPS_PER_REQUEST) return reply.code(400).send({ error: `article_ids must be a list of 1 to ${MAX_SKIPS_PER_REQUEST}` });
      const ids = raw.map(uuid);
      if (ids.some((id) => id === null)) return reply.code(400).send({ error: 'article_ids must be ids of articles' });
      if (!deps.skipLimiter.take(who.accountId)) return reply.code(429).send({ error: 'too many requests; try again later' });
      await deps.accounts.addSkips(who.accountId, ids as string[]);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error, 'skips');
    }
  });
}
