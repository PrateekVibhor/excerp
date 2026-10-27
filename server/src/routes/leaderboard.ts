import type { FastifyInstance } from 'fastify';
import type { LeaderboardStore } from '../leaderboard.ts';
import { bearerToken } from './auth.ts';
import { normalizeDeviceId } from './verifications.ts';

/** GET /leaderboard?device_id=: the top 50 and, for a known device, its own rank. Only name, count and rank leave the server. */
export function registerLeaderboardRoute(app: FastifyInstance, deps: { leaderboard: LeaderboardStore; accountForToken?: (token: string) => Promise<string | null> }) {
  app.get<{ Querystring: { device_id?: string } }>('/leaderboard', async (request, reply) => {
    const raw = request.query.device_id;
    let device: string | undefined;
    if (raw !== undefined && raw !== '') {
      const normalized = normalizeDeviceId(raw);
      if (normalized === null) return reply.code(400).send({ error: 'device_id must be a UUID' });
      device = normalized;
    }
    try {
      reply.header('Cache-Control', 'no-store'); // it changes whenever anyone verifies
      // A signed-in reader is found by the session; the device id is for apps from before accounts.
      const token = bearerToken(request);
      const account = token !== undefined && deps.accountForToken ? await deps.accountForToken(token) : null;
      return await deps.leaderboard.leaderboard(device, undefined, account ?? undefined);
    } catch {
      return reply.code(503).send({ error: 'leaderboard unavailable' });
    }
  });
}
