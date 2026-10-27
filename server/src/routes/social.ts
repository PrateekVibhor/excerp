import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AccountStore } from '../accounts.ts';
import type { AuthStore } from '../authStore.ts';
import type { RateLimiter } from '../rateLimit.ts';
import { NOTE_MAX, REPORT_REASONS, SocialError, type ReportReason, type SettingsPatch } from '../social.ts';
import { requireAccount } from './me.ts';
import { UUID } from './verifications.ts';

export interface SocialDeps {
  store: AuthStore;
  accounts: AccountStore;
  approved: (email: string) => Promise<boolean>;
  /** Looks at readers and cards, per account an hour. */
  readersLimiter: RateLimiter;
  /** New reports, per account a day. */
  reportsLimiter: RateLimiter;
  now: () => Date;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a refusal looks like: only its code, never a detail. */
function refuse(reply: FastifyReply, error: unknown, what: string) {
  if (error instanceof SocialError) return reply.code(error.status).send({ error: error.code });
  return reply.code(503).send({ error: `${what} unavailable` }); // never echo database details
}

/**
 * Readers who chose to be seen, blocks, reports and the switches (Plan 15). Everything needs a signed-in, approved reader with
 * an account. Nothing here ever returns an email, a Google id, an account id, a reference code or a device number.
 */
export function registerSocialRoutes(app: FastifyInstance, deps: SocialDeps) {
  app.get('/me/messaging-settings', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      return await deps.accounts.getSettings(who.accountId);
    } catch (error) {
      return refuse(reply, error, 'settings');
    }
  });

  app.put('/me/messaging-settings', { bodyLimit: 1024 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const body = request.body;
      if (!isObject(body)) return reply.code(400).send({ error: 'the body must be a JSON object' });
      const patch: SettingsPatch = {};
      for (const key of ['discoverable', 'accepts_messages'] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} must be true or false` });
        patch[key] = body[key];
      }
      for (const key of ['confirm_adult', 'accept_terms'] as const) {
        if (body[key] === undefined) continue;
        if (body[key] !== true) return reply.code(400).send({ error: `${key} must be true` }); // a confirmation is only ever "yes"
        patch[key] = true;
      }
      return await deps.accounts.updateSettings(who.accountId, patch, deps.now());
    } catch (error) {
      return refuse(reply, error, 'settings');
    }
  });

  app.get<{ Params: { id: string } }>('/articles/:id/readers', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      if (!deps.readersLimiter.take(who.accountId)) return reply.code(429).send({ error: 'too many requests; try again later' });
      return await deps.accounts.readersOf(who.accountId, request.params.id, deps.now());
    } catch (error) {
      return refuse(reply, error, 'readers');
    }
  });

  app.get<{ Params: { publicId: string } }>('/readers/:publicId', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      if (!deps.readersLimiter.take(who.accountId)) return reply.code(429).send({ error: 'too many requests; try again later' });
      return await deps.accounts.card(who.accountId, request.params.publicId, deps.now());
    } catch (error) {
      return refuse(reply, error, 'readers');
    }
  });

  app.post('/me/blocks', { bodyLimit: 1024 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const id = isObject(request.body) ? request.body.public_id : undefined;
      if (typeof id !== 'string' || !UUID.test(id)) return reply.code(400).send({ error: 'public_id must be a UUID' });
      await deps.accounts.block(who.accountId, id, deps.now());
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'blocks');
    }
  });

  app.get('/me/blocks', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      return { blocks: await deps.accounts.listBlocks(who.accountId) };
    } catch (error) {
      return refuse(reply, error, 'blocks');
    }
  });

  app.delete<{ Params: { publicId: string } }>('/me/blocks/:publicId', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      if (!UUID.test(request.params.publicId)) return reply.code(400).send({ error: 'public_id must be a UUID' });
      await deps.accounts.unblock(who.accountId, request.params.publicId);
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'blocks');
    }
  });

  app.post('/me/reports', { bodyLimit: 4096 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const body = request.body;
      if (!isObject(body)) return reply.code(400).send({ error: 'the body must be a JSON object' });
      // A reader or a message: exactly one of the two.
      if ((body.public_id === undefined) === (body.message_id === undefined)) return reply.code(400).send({ error: 'give either public_id (a reader) or message_id (a message)' });
      const aMessage = body.message_id !== undefined;
      const subject = aMessage ? body.message_id : body.public_id;
      if (typeof subject !== 'string' || !UUID.test(subject)) return reply.code(400).send({ error: `${aMessage ? 'message_id' : 'public_id'} must be a UUID` });
      if (typeof body.reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(body.reason)) return reply.code(400).send({ error: `reason must be one of ${REPORT_REASONS.join(', ')}` });
      if (body.note !== undefined && (typeof body.note !== 'string' || [...body.note].length > NOTE_MAX)) return reply.code(400).send({ error: `note must be at most ${NOTE_MAX} characters` });
      if (body.article_id !== undefined && (typeof body.article_id !== 'string' || !UUID.test(body.article_id))) return reply.code(400).send({ error: 'article_id must be a UUID' });
      if (body.also_block !== undefined && typeof body.also_block !== 'boolean') return reply.code(400).send({ error: 'also_block must be true or false' });
      const take = (id: string) => deps.reportsLimiter.take(id);
      if (aMessage) {
        await deps.accounts.reportMessage(who.accountId, { messageId: subject, reason: body.reason as ReportReason, note: body.note as string | undefined, alsoBlock: body.also_block === true }, deps.now(), take);
      } else {
        await deps.accounts.report(
          who.accountId,
          { publicId: subject, reason: body.reason as ReportReason, note: body.note as string | undefined, articleId: body.article_id as string | undefined, alsoBlock: body.also_block === true },
          deps.now(),
          take,
        );
      }
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'report');
    }
  });
}
