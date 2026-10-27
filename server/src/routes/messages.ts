import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AccountStore } from '../accounts.ts';
import type { AuthStore } from '../authStore.ts';
import { checkMessageText } from '../messageText.ts';
import type { MessageLimits } from '../messages.ts';
import { SocialError } from '../social.ts';
import { requireAccount } from './me.ts';
import { UUID } from './verifications.ts';

export interface MessageDeps {
  store: AuthStore;
  accounts: AccountStore;
  approved: (email: string) => Promise<boolean>;
  limits: MessageLimits;
  now: () => Date;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function refuse(reply: FastifyReply, error: unknown, what: string) {
  if (error instanceof SocialError) return reply.code(error.status).send({ error: error.code });
  return reply.code(503).send({ error: `${what} unavailable` }); // never echo database details
}

/**
 * Message requests and conversations (Plan 15). A first message is a request that the person asked must accept; a decline is
 * silent. Everything needs a signed-in, approved reader with an account, and nothing is ever cached.
 */
export function registerMessageRoutes(app: FastifyInstance, deps: MessageDeps) {
  app.post('/me/messages', { bodyLimit: 16_384 }, async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const body = request.body;
      if (!isObject(body)) return reply.code(400).send({ error: 'the body must be a JSON object' });
      const hasTo = body.to !== undefined;
      const hasConversation = body.conversation_id !== undefined;
      if (hasTo === hasConversation) return reply.code(400).send({ error: 'give either to (a new request) or conversation_id (a reply)' });
      const target = hasTo ? body.to : body.conversation_id;
      if (typeof target !== 'string' || !UUID.test(target)) return reply.code(400).send({ error: `${hasTo ? 'to' : 'conversation_id'} must be a UUID` });
      const text = checkMessageText(body.subject, body.body);
      if (!text.ok) return reply.code(400).send({ error: text.error });
      if (body.article_id !== undefined && (!hasTo || typeof body.article_id !== 'string' || !UUID.test(body.article_id))) return reply.code(400).send({ error: 'article_id must be the id of an article' });
      await deps.accounts.send(
        who.accountId,
        { to: hasTo ? target : undefined, conversationId: hasConversation ? target : undefined, subject: text.subject, body: text.body, articleId: body.article_id as string | undefined },
        deps.now(),
        deps.limits,
      );
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'messages');
    }
  });

  app.get('/me/inbox', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      return await deps.accounts.inbox(who.accountId, deps.now());
    } catch (error) {
      return refuse(reply, error, 'inbox');
    }
  });

  app.get<{ Querystring: { since?: string } }>('/me/inbox/changes', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      const raw = request.query.since;
      if (raw !== undefined && !/^\d{1,15}$/.test(raw)) return reply.code(400).send({ error: 'since must be a whole number' });
      return await deps.accounts.changes(who.accountId, raw === undefined ? 0 : Number(raw), deps.now());
    } catch (error) {
      return refuse(reply, error, 'inbox');
    }
  });

  app.get<{ Params: { id: string } }>('/me/conversations/:id', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      return await deps.accounts.thread(who.accountId, request.params.id, deps.now());
    } catch (error) {
      return refuse(reply, error, 'conversation');
    }
  });

  for (const [verb, method] of [['accept', 'accept'], ['decline', 'decline']] as const) {
    app.post<{ Params: { id: string } }>(`/me/conversations/:id/${verb}`, async (request, reply) => {
      try {
        const who = await requireAccount(request, reply, deps);
        if (!who) return reply;
        await deps.accounts[method](who.accountId, request.params.id, deps.now());
        return reply.code(204).send();
      } catch (error) {
        return refuse(reply, error, 'conversation');
      }
    });
  }

  app.post<{ Params: { id: string } }>('/me/messages/:id/read', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      await deps.accounts.markRead(who.accountId, request.params.id, deps.now());
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'messages');
    }
  });

  app.delete<{ Params: { id: string } }>('/me/messages/:id', async (request, reply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      await deps.accounts.hide(who.accountId, request.params.id, deps.now());
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error, 'messages');
    }
  });
}
