import { createHash } from 'node:crypto';
import type pg from 'pg';
import { maybeAutoSuspend, SocialError, type ReportReason } from './social.ts';

/** An unanswered request is closed after this long. */
export const REQUEST_DAYS = 30;
/** Every message is deleted this long after it was sent. */
export const MESSAGE_DAYS = 365;
export const PITCHES_PER_DAY = 5;
export const MESSAGES_PER_DAY = 20;
/** The same text may go to this many different people in a day, and no more. */
export const SAME_TEXT_TO_PEOPLE = 3;
const DAY_MS = 86_400_000;
const LIVE = 'm.expires_at > $NOW';

export interface MessageLimits {
  pitchesPerDay?: number;
  messagesPerDay?: number;
}
export interface SendInput {
  /** The public id of the person to write to (a new request), or ... */
  to?: string;
  /** ... the conversation to write in (a reply). Exactly one of the two. */
  conversationId?: string;
  subject: string;
  body: string;
  articleId?: string;
}
export interface MessageView {
  id: string;
  from: 'me' | 'them';
  subject: string;
  body: string;
  created_at: string;
  read: boolean;
}
export interface OtherView {
  public_id: string | null;
  display_name: string;
  industry: string | null;
  interests: string[];
  deleted: boolean;
}
export interface ConversationView {
  id: string;
  /** request / open for the person asked; pending / expired / open for the person who asked; declined or gone only in the change feed. */
  state: 'request' | 'open' | 'pending' | 'expired' | 'declined' | 'gone';
  role: 'initiator' | 'recipient';
  other: OtherView;
  article_id: string | null;
  created_at: string;
  last_message_at: string;
  unread: number;
  last_message: MessageView | null;
}
export interface Inbox {
  cursor: number;
  unread: number;
  requests: ConversationView[];
  conversations: ConversationView[];
  sent: ConversationView[];
}

export interface MessageStore {
  /**
   * A new request to someone, or a reply in an open conversation. Resolves quietly when the two have blocked each other, so the
   * sender cannot tell. Throws SocialError for everything else.
   */
  send(senderId: string, input: SendInput, now: Date, limits?: MessageLimits): Promise<void>;
  inbox(accountId: string, now: Date): Promise<Inbox>;
  /** Conversations that changed after the cursor, and the cursor to ask from next time (one that only follows this reader's own conversations). */
  changes(accountId: string, since: number, now: Date): Promise<{ cursor: number; unread: number; conversations: ConversationView[] }>;
  thread(accountId: string, conversationId: string, now: Date): Promise<ConversationView & { messages: MessageView[] }>;
  accept(accountId: string, conversationId: string, now: Date): Promise<void>;
  decline(accountId: string, conversationId: string, now: Date): Promise<void>;
  markRead(accountId: string, messageId: string, now: Date): Promise<void>;
  /** Takes the message out of this reader's own view only. */
  hide(accountId: string, messageId: string, now: Date): Promise<void>;
  /** Reports a message received, keeping a frozen copy; the message leaves the reporter's view. */
  reportMessage(
    reporterId: string,
    input: { messageId: string; reason: ReportReason; note?: string; alsoBlock?: boolean },
    now: Date,
    take: (accountId: string) => boolean,
  ): Promise<void>;
  /** Whether the moderator has banned this Google account. */
  isBanned(sub: string, provider?: 'google' | 'apple'): Promise<boolean>;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const NOT_FOUND = () => new SocialError(404, 'not found');
/** Lower case, spaces squeezed: the same words typed differently count as the same text. */
const textKey = (body: string) => createHash('md5').update(body.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
const older = (date: Date, days: number, now: Date) => now.getTime() - date.getTime() >= days * DAY_MS;

interface ConvRow {
  id: string; initiator_id: string | null; recipient_id: string | null; article_id: string | null; state: 'request' | 'open' | 'declined' | 'expired';
  created_at: Date; accepted_at: Date | null; state_seq: string; role: 'initiator' | 'recipient';
  o_public_id: string | null; o_name: string | null; o_industry: string | null; o_interests: string[] | null; o_deleted: boolean;
}
interface MsgRow {
  id: string; conversation_id: string; sender_id: string | null; recipient_id: string | null; subject: string; body: string;
  created_at: Date; read_at: Date | null; seq: string;
}

/** How a conversation looks to this person today (see ConversationView.state). */
function effectiveState(c: ConvRow, now: Date): ConversationView['state'] {
  const stale = older(c.created_at, REQUEST_DAYS, now);
  if (c.state === 'open') return 'open';
  if (c.role === 'recipient') return c.state === 'request' ? (stale ? 'expired' : 'request') : c.state; // declined / expired
  // The person who asked is told nothing about a decline: it looks the same as waiting, and then as expired.
  return c.state === 'expired' || stale ? 'expired' : 'pending';
}

export function createMessageStore(pool: pg.Pool): MessageStore {
  /** The conversations a person is in with someone who has not blocked them or been blocked by them. */
  const CONVERSATIONS = `
    SELECT c.id, c.initiator_id, c.recipient_id, c.article_id, c.state, c.created_at, c.accepted_at, c.state_seq,
           CASE WHEN c.initiator_id = $1 THEN 'initiator' ELSE 'recipient' END AS role,
           o.public_id AS o_public_id, o.display_name AS o_name, o.industry AS o_industry, o.interests AS o_interests, (o.id IS NULL) AS o_deleted
    FROM conversations c
    LEFT JOIN accounts o ON o.id = CASE WHEN c.initiator_id = $1 THEN c.recipient_id ELSE c.initiator_id END
    WHERE (c.initiator_id = $1 OR c.recipient_id = $1)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = o.id) OR (b.blocker_id = o.id AND b.blocked_id = $1))`;

  /** The messages in these conversations that this person can see: theirs, not hidden by them, not past twelve months. */
  const visibleMessages = async (accountId: string, ids: string[], now: Date): Promise<MsgRow[]> =>
    ids.length === 0
      ? []
      : (
          await pool.query<MsgRow>(
            `SELECT m.id, m.conversation_id, m.sender_id, m.recipient_id, m.subject, m.body, m.created_at, m.read_at, m.seq
             FROM messages m
             WHERE m.conversation_id = ANY($2::uuid[]) AND m.expires_at > $3
               AND ((m.sender_id = $1 AND m.hidden_by_sender_at IS NULL) OR (m.recipient_id = $1 AND m.hidden_by_recipient_at IS NULL))
             ORDER BY m.created_at, m.seq`,
            [accountId, ids, now],
          )
        ).rows;

  const other = (c: ConvRow): OtherView =>
    c.o_deleted
      ? { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true }
      : { public_id: c.o_public_id, display_name: c.o_name ?? 'Reader', industry: c.o_industry, interests: c.o_interests ?? [], deleted: false };

  const messageView = (accountId: string, m: MsgRow): MessageView => ({
    id: m.id,
    from: m.sender_id === accountId ? 'me' : 'them',
    subject: m.subject,
    body: m.body,
    created_at: m.created_at.toISOString(),
    read: m.sender_id === accountId ? true : m.read_at !== null, // nobody learns whether their message was read
  });

  function views(accountId: string, convs: ConvRow[], msgs: MsgRow[], now: Date, keepEmpty: boolean): ConversationView[] {
    const by = new Map<string, MsgRow[]>();
    for (const m of msgs) by.set(m.conversation_id, [...(by.get(m.conversation_id) ?? []), m]);
    const out: ConversationView[] = [];
    for (const c of convs) {
      const mine = by.get(c.id) ?? [];
      const last = mine[mine.length - 1];
      if (!last && !keepEmpty) continue;
      out.push({
        id: c.id,
        state: last ? effectiveState(c, now) : 'gone',
        role: c.role,
        other: other(c),
        article_id: c.article_id,
        created_at: c.created_at.toISOString(),
        last_message_at: (last?.created_at ?? c.created_at).toISOString(),
        unread: mine.filter((m) => m.sender_id !== accountId && m.read_at === null).length,
        last_message: last ? messageView(accountId, last) : null,
      });
    }
    return out.sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1));
  }

  async function inbox(accountId: string, now: Date): Promise<Inbox> {
    const convs = (await pool.query<ConvRow>(`${CONVERSATIONS} ORDER BY c.created_at DESC LIMIT 500`, [accountId])).rows;
    const all = views(accountId, convs, await visibleMessages(accountId, convs.map((c) => c.id), now), now, false);
    const requests = all.filter((v) => v.role === 'recipient' && v.state === 'request');
    const conversations = all.filter((v) => v.state === 'open');
    const sent = all.filter((v) => v.role === 'initiator' && (v.state === 'pending' || v.state === 'expired'));
    const unread = [...requests, ...conversations].reduce((n, v) => n + v.unread, 0);
    const { rows } = await pool.query<{ s: string | null }>(
      `SELECT GREATEST(
         (SELECT max(state_seq) FROM conversations WHERE initiator_id = $1 OR recipient_id = $1),
         (SELECT max(seq) FROM messages WHERE sender_id = $1 OR recipient_id = $1)) AS s`,
      [accountId],
    );
    return { cursor: Number(rows[0].s ?? 0), unread, requests, conversations, sent };
  }

  async function ownConversation(accountId: string, conversationId: string): Promise<ConvRow> {
    if (!isUuid(conversationId)) throw NOT_FOUND();
    const { rows } = await pool.query<ConvRow>(`${CONVERSATIONS} AND c.id = $2`, [accountId, conversationId.toLowerCase()]);
    if (!rows[0]) throw NOT_FOUND();
    return rows[0];
  }

  async function answer(accountId: string, conversationId: string, now: Date, to: 'open' | 'declined') {
    if (!isUuid(conversationId)) throw NOT_FOUND();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<ConvRow>(`${CONVERSATIONS} AND c.id = $2 AND c.recipient_id = $1 FOR UPDATE OF c`, [accountId, conversationId.toLowerCase()]);
      const c = found.rows[0];
      if (!c) throw NOT_FOUND(); // only the person asked can answer
      if (c.state === 'open') {
        if (to === 'declined') throw new SocialError(409, 'already_open');
      } else if (c.state === 'declined') {
        if (to === 'open') throw new SocialError(409, 'closed');
      } else if (c.state === 'expired' || older(c.created_at, REQUEST_DAYS, now)) {
        throw new SocialError(409, 'expired');
      } else {
        await client.query(`UPDATE conversations SET state = $2, accepted_at = $3, state_seq = nextval('inbox_seq') WHERE id = $1`, [c.id, to, to === 'open' ? now : null]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async isBanned(sub, provider = 'google') {
      return (await pool.query(`SELECT 1 FROM accounts WHERE ${provider === 'apple' ? 'apple_sub' : 'google_sub'} = $1 AND banned_at IS NOT NULL`, [sub])).rowCount === 1;
    },

    async send(senderId, input, now, limits = {}) {
      const maxPitches = limits.pitchesPerDay ?? PITCHES_PER_DAY;
      const maxMessages = limits.messagesPerDay ?? MESSAGES_PER_DAY;
      const dayAgo = new Date(now.getTime() - DAY_MS);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // One sender's requests are decided one at a time, so the limits below cannot be raced past.
        const me = (await client.query(`SELECT adult_confirmed_at, terms_accepted_at, suspended_until FROM accounts WHERE id = $1 FOR UPDATE`, [senderId])).rows[0];
        if (!me) throw NOT_FOUND();
        if (me.suspended_until && me.suspended_until > now) throw new SocialError(403, 'suspended');

        let conversationId: string;
        let recipientId: string;
        let isRequest = false;
        if (input.conversationId !== undefined) {
          if (!isUuid(input.conversationId)) throw NOT_FOUND();
          const found = await client.query<ConvRow>(`${CONVERSATIONS} AND c.id = $2 FOR UPDATE OF c`, [senderId, input.conversationId.toLowerCase()]);
          const hidden = found.rows[0] === undefined;
          if (hidden) {
            // Not theirs, not there, or blocked: if it is theirs but blocked, it looks sent and nothing is kept.
            const mine = await client.query('SELECT 1 FROM conversations WHERE id = $1 AND (initiator_id = $2 OR recipient_id = $2)', [input.conversationId.toLowerCase(), senderId]);
            if (mine.rowCount === 1) {
              await client.query('COMMIT');
              return;
            }
            throw NOT_FOUND();
          }
          const c = found.rows[0];
          const otherId = c.role === 'initiator' ? c.recipient_id : c.initiator_id;
          if (c.state !== 'open') {
            if (c.role === 'initiator') throw new SocialError(409, 'awaiting_acceptance');
            throw new SocialError(409, c.state === 'request' && !older(c.created_at, REQUEST_DAYS, now) ? 'accept_first' : 'closed');
          }
          if (otherId === null) throw new SocialError(409, 'deleted account');
          conversationId = c.id;
          recipientId = otherId;
        } else {
          isRequest = true;
          if (me.adult_confirmed_at === null || me.terms_accepted_at === null) throw new SocialError(403, 'confirmation required');
          const verified = await client.query('SELECT 1 FROM account_verifications WHERE account_id = $1 LIMIT 1', [senderId]);
          if (verified.rowCount === 0) throw new SocialError(403, 'verify_first');
          if (input.to === undefined || !isUuid(input.to)) throw new SocialError(400, 'to must be a UUID');
          const target = (
            await client.query<{ id: string; ok: boolean }>(
              `SELECT a.id, (a.discoverable AND a.accepts_messages AND (a.suspended_until IS NULL OR a.suspended_until <= $2)) AS ok FROM accounts a WHERE a.public_id = $1`,
              [input.to.toLowerCase(), now],
            )
          ).rows[0];
          if (!target || !target.ok || target.id === senderId) throw NOT_FOUND();
          const blocked = await client.query(
            `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
            [senderId, target.id],
          );
          if (blocked.rowCount === 1) {
            await client.query('COMMIT'); // looks sent
            return;
          }
          const existing = await client.query(
            `SELECT 1 FROM conversations WHERE LEAST(initiator_id, recipient_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(initiator_id, recipient_id) = GREATEST($1::uuid, $2::uuid)`,
            [senderId, target.id],
          );
          if (existing.rowCount === 1) throw new SocialError(409, 'already_requested');
          const pitches = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM conversations WHERE initiator_id = $1 AND created_at > $2', [senderId, dayAgo]);
          if (pitches.rows[0].n >= maxPitches) throw new SocialError(429, 'too many requests; try again later');
          const same = await client.query<{ n: number }>(
            'SELECT count(DISTINCT recipient_id)::int AS n FROM messages WHERE sender_id = $1 AND body_key = $2 AND created_at > $3',
            [senderId, textKey(input.body), dayAgo],
          );
          if (same.rows[0].n >= SAME_TEXT_TO_PEOPLE) throw new SocialError(429, 'repeated message');
          if (input.articleId !== undefined) {
            const article = await client.query('SELECT 1 FROM articles WHERE id = $1', [input.articleId.toLowerCase()]);
            if (article.rowCount === 0) throw new SocialError(400, 'article_id must be the id of an article');
          }
          conversationId = (
            await client.query<{ id: string }>(
              `INSERT INTO conversations (initiator_id, recipient_id, article_id, state, created_at) VALUES ($1, $2, $3, 'request', $4) RETURNING id`,
              [senderId, target.id, input.articleId?.toLowerCase() ?? null, now],
            )
          ).rows[0].id;
          recipientId = target.id;
        }

        const sentToday = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE sender_id = $1 AND created_at > $2', [senderId, dayAgo]);
        if (sentToday.rows[0].n >= maxMessages) throw new SocialError(429, 'too many messages; try again later');
        if (!isRequest) {
          const blocked = await client.query(
            `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
            [senderId, recipientId],
          );
          if (blocked.rowCount === 1) {
            await client.query('COMMIT');
            return;
          }
        }
        await client.query(
          `INSERT INTO messages (conversation_id, sender_id, recipient_id, subject, body, body_key, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [conversationId, senderId, recipientId, input.subject, input.body, textKey(input.body), now, new Date(now.getTime() + MESSAGE_DAYS * DAY_MS)],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    inbox,

    async changes(accountId, since, now) {
      const convs = (
        await pool.query<ConvRow>(
          `${CONVERSATIONS}
           AND (c.state_seq > $2 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.seq > $2 AND (m.sender_id = $1 OR m.recipient_id = $1)))
           ORDER BY c.created_at DESC LIMIT 500`,
          [accountId, since],
        )
      ).rows;
      const list = views(accountId, convs, await visibleMessages(accountId, convs.map((c) => c.id), now), now, true);
      const seqs = await pool.query<{ s: string | null }>(
        `SELECT GREATEST(
           (SELECT max(state_seq) FROM conversations WHERE id = ANY($2::uuid[])),
           (SELECT max(seq) FROM messages WHERE conversation_id = ANY($2::uuid[]) AND (sender_id = $1 OR recipient_id = $1))) AS s`,
        [accountId, convs.map((c) => c.id)],
      );
      const top = Number(seqs.rows[0].s ?? 0);
      return { cursor: Math.max(since, top), unread: (await inbox(accountId, now)).unread, conversations: list };
    },

    async thread(accountId, conversationId, now) {
      const c = await ownConversation(accountId, conversationId);
      const msgs = await visibleMessages(accountId, [c.id], now);
      const [view] = views(accountId, [c], msgs, now, false);
      // A request that has lapsed, or been declined, is no longer the recipient's to open.
      if (!view || view.state === 'declined' || (view.role === 'recipient' && view.state === 'expired')) throw NOT_FOUND();
      return { ...view, messages: msgs.map((m) => messageView(accountId, m)) };
    },

    accept: (accountId, conversationId, now) => answer(accountId, conversationId, now, 'open'),
    decline: (accountId, conversationId, now) => answer(accountId, conversationId, now, 'declined'),

    async markRead(accountId, messageId, now) {
      if (!isUuid(messageId)) throw NOT_FOUND();
      const { rowCount } = await pool.query(
        `UPDATE messages SET read_at = COALESCE(read_at, $3), seq = CASE WHEN read_at IS NULL THEN nextval('inbox_seq') ELSE seq END
         WHERE id = $2 AND recipient_id = $1 AND hidden_by_recipient_at IS NULL AND expires_at > $3`,
        [accountId, messageId.toLowerCase(), now],
      );
      if (rowCount === 0) throw NOT_FOUND();
    },

    async hide(accountId, messageId, now) {
      if (!isUuid(messageId)) throw NOT_FOUND();
      const { rowCount } = await pool.query(
        `UPDATE messages SET
           hidden_by_sender_at = CASE WHEN sender_id = $1 THEN COALESCE(hidden_by_sender_at, $3) ELSE hidden_by_sender_at END,
           hidden_by_recipient_at = CASE WHEN recipient_id = $1 THEN COALESCE(hidden_by_recipient_at, $3) ELSE hidden_by_recipient_at END,
           seq = nextval('inbox_seq')
         WHERE id = $2 AND (sender_id = $1 OR recipient_id = $1) AND expires_at > $3`,
        [accountId, messageId.toLowerCase(), now],
      );
      if (rowCount === 0) throw NOT_FOUND();
    },

    async reportMessage(reporterId, input, now, take) {
      if (!isUuid(input.messageId)) throw NOT_FOUND();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query<{
          id: string; conversation_id: string; sender_id: string | null; subject: string; body: string; created_at: Date; article_id: string | null;
          s_public_id: string | null; s_name: string | null; s_industry: string | null; s_interests: string[] | null;
        }>(
          `SELECT m.id, m.conversation_id, m.sender_id, m.subject, m.body, m.created_at, c.article_id,
                  s.public_id AS s_public_id, s.display_name AS s_name, s.industry AS s_industry, s.interests AS s_interests
           FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN accounts s ON s.id = m.sender_id
           WHERE m.id = $2 AND m.recipient_id = $1 AND m.hidden_by_recipient_at IS NULL AND m.expires_at > $3
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = m.sender_id) OR (b.blocker_id = m.sender_id AND b.blocked_id = $1))`,
          [reporterId, input.messageId.toLowerCase(), now],
        );
        const m = found.rows[0];
        if (!m) {
          const own = await client.query('SELECT 1 FROM messages WHERE id = $1 AND sender_id = $2', [input.messageId.toLowerCase(), reporterId]);
          throw own.rowCount === 1 ? new SocialError(400, 'cannot report your own message') : NOT_FOUND();
        }
        const again = await client.query('SELECT 1 FROM reports WHERE reporter_id = $1 AND message_id = $2', [reporterId, m.id]);
        if (again.rowCount === 0) {
          if (!take(reporterId)) throw new SocialError(429, 'too many reports; try again later');
          const snapshot = {
            message: { subject: m.subject, body: m.body, created_at: m.created_at.toISOString() },
            sender: m.sender_id ? { public_id: m.s_public_id, display_name: m.s_name, industry: m.s_industry, interests: m.s_interests ?? [] } : null,
            conversation_id: m.conversation_id,
            ...(m.article_id ? { article_id: m.article_id } : {}),
          };
          await client.query(
            `INSERT INTO reports (reporter_id, reported_id, message_id, kind, reason, note, snapshot, created_at) VALUES ($1, $2, $3, 'message', $4, $5, $6::jsonb, $7)`,
            [reporterId, m.sender_id, m.id, input.reason, input.note ?? null, JSON.stringify(snapshot), now],
          );
          if (m.sender_id) await maybeAutoSuspend(client, m.sender_id, now);
        }
        // The message leaves the reporter's view; the sender is not told and keeps their copy.
        await client.query(`UPDATE messages SET hidden_by_recipient_at = COALESCE(hidden_by_recipient_at, $2), seq = nextval('inbox_seq') WHERE id = $1`, [m.id, now]);
        if (input.alsoBlock && m.sender_id) await client.query('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [reporterId, m.sender_id, now]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
