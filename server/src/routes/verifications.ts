import type { FastifyInstance } from 'fastify';
import type { LeaderboardStore, SyncVerification } from '../leaderboard.ts';
import type { RateLimiter } from '../rateLimit.ts';

export const MAX_NAME_CHARS = 40;
export const MAX_BODY_BYTES = 4096;
export const POSTS_PER_HOUR = 60;
/** Per address, across all devices: a family on one wifi shares it, a script minting fake players does not get far. */
export const POSTS_PER_HOUR_PER_IP = 120;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type Parsed = { ok: true; value: SyncVerification } | { ok: false; error: string };

/** Lower-cased UUID, or null when the text is not one. */
export const normalizeDeviceId = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);

/** Checks what the app sent. Extra fields are ignored; everything the server stores is checked here. */
export function parseVerification(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'the body must be a JSON object' };
  const { device_id, display_name, article_id, verified_at } = body as Record<string, unknown>;
  const device = normalizeDeviceId(device_id);
  if (device === null) return { ok: false, error: 'device_id must be a UUID' };
  if (typeof display_name !== 'string') return { ok: false, error: `display_name must be 1 to ${MAX_NAME_CHARS} characters` };
  const name = display_name.trim();
  const length = [...name].length; // characters, as the database counts them, not UTF-16 units
  if (length < 1 || length > MAX_NAME_CHARS) return { ok: false, error: `display_name must be 1 to ${MAX_NAME_CHARS} characters` };
  if (/\p{Cc}/u.test(name)) return { ok: false, error: 'display_name must not contain control characters' };
  if (typeof article_id !== 'string' || !UUID.test(article_id)) return { ok: false, error: 'article_id must be the id of an article' };
  if (typeof verified_at !== 'string' || !ISO_DATE_TIME.test(verified_at) || Number.isNaN(Date.parse(verified_at))) {
    return { ok: false, error: 'verified_at must be an ISO 8601 date and time' };
  }
  return { ok: true, value: { device_id: device, display_name: name, article_id: article_id.toLowerCase(), verified_at } };
}

/**
 * POST /verifications: 204 whether or not the verification was new, 400 for bad input, 429 over the hourly allowance of
 * the device or of the address it came from. The address is the connection's own. X-Forwarded-For is believed only when
 * the connection comes from the configured proxy (TRUST_PROXY, the Caddy container); from anyone else a client could
 * write anything in it.
 */
export function registerVerificationRoutes(app: FastifyInstance, deps: { leaderboard: LeaderboardStore; limiter: RateLimiter; ipLimiter: RateLimiter; now: () => Date }) {
  app.post('/verifications', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const parsed = parseVerification(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    // Per address first, so a refused request does not use up the device's own allowance. Only requests that pass the
    // checks above count: an invalid one costs nothing to answer and stores nothing.
    if (!deps.ipLimiter.take(request.ip || 'unknown') || !deps.limiter.take(parsed.value.device_id)) {
      return reply.code(429).send({ error: 'too many verifications; try again later' });
    }
    try {
      await deps.leaderboard.record(parsed.value, deps.now());
    } catch (error) {
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23503' && (constraint === 'verifications_article_id_fkey' || constraint === 'account_verifications_article_id_fkey')) return reply.code(400).send({ error: 'article_id must be the id of an article' });
      return reply.code(503).send({ error: 'verification not saved' }); // never echo database details
    }
    return reply.code(204).send();
  });
}
