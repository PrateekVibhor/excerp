import { createHash } from 'node:crypto';
import type pg from 'pg';

/** Reading an article means having it saved (and not removed) or verified within this long. */
export const READER_WINDOW_DAYS = 30;
/** How many readers an article shows. */
export const READERS_SHOWN = 5;
/** A reader count below this is not said at all, so a tiny number cannot point at a person. */
export const MIN_READER_COUNT = 3;
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'scam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const NOTE_MAX = 500;
const DAY_MS = 86_400_000;

/** A refusal the route turns into an answer. `code` is the machine-readable part. */
export class SocialError extends Error {
  status: 400 | 403 | 404 | 409 | 429;
  code: string;
  constructor(status: 400 | 403 | 404 | 409 | 429, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface MessagingSettings {
  discoverable: boolean;
  accepts_messages: boolean;
  adult_confirmed: boolean;
  terms_accepted: boolean;
}
export interface SettingsPatch {
  discoverable?: boolean;
  accepts_messages?: boolean;
  confirm_adult?: true;
  accept_terms?: true;
}
export interface ReaderEntry {
  public_id: string;
  display_name: string;
  industry: string;
  interests: string[];
  shared_interests: number;
  action: 'saved' | 'verified';
  can_message: boolean;
}
export interface ReaderCard {
  public_id: string;
  display_name: string;
  industry: string;
  interests: string[];
  verified_count: number;
  can_message: boolean;
}
export interface BlockEntry {
  public_id: string;
  display_name: string;
  blocked_at: Date;
}

export interface SocialStore {
  getSettings(accountId: string): Promise<MessagingSettings>;
  /**
   * Turning visibility or messages on needs: 18+ and Terms confirmed (now or before), a saved profile name, no suspension, and for
   * messages, visibility. Turning off is always allowed, and turning visibility off turns messages off too. All or nothing.
   * Throws SocialError.
   */
  updateSettings(accountId: string, patch: SettingsPatch, now: Date): Promise<MessagingSettings>;
  /** The readers of an article. Throws SocialError (403 visibility_required, 404 article not found). */
  readersOf(viewerId: string, articleId: string, now: Date): Promise<{ count: number; readers: ReaderEntry[] }>;
  /** A reader's card. 404 `not found`, the same for every reason it cannot be shown. */
  card(viewerId: string, publicId: string, now: Date): Promise<ReaderCard>;
  block(accountId: string, publicId: string, now: Date): Promise<void>;
  unblock(accountId: string, publicId: string): Promise<void>;
  listBlocks(accountId: string): Promise<BlockEntry[]>;
  /** Keeps a report with a frozen copy of the profile. A repeat within 24 hours makes none. `take` is the daily allowance, used only for a new report. */
  report(
    reporterId: string,
    input: { publicId: string; reason: ReportReason; note?: string; articleId?: string; alsoBlock?: boolean },
    now: Date,
    take: (accountId: string) => boolean,
  ): Promise<void>;
}

/** Different readers who report the same person within this many days pause them until the owner looks. */
export const STRIKE_DAYS = 7;
export const STRIKES = 3;

/**
 * If enough different readers have reported this account lately, hides it and stops its messaging for a week and writes that to the
 * moderation log. Does nothing if it is already suspended. Runs inside the report's transaction.
 */
export async function maybeAutoSuspend(client: pg.PoolClient, reportedId: string, now: Date): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(DISTINCT reporter_id)::int AS n FROM reports WHERE reported_id = $1 AND reporter_id IS NOT NULL AND created_at > $2`,
    [reportedId, new Date(now.getTime() - STRIKE_DAYS * DAY_MS)],
  );
  if (rows[0].n < STRIKES) return;
  const account = (await client.query(`SELECT suspended_until, public_id FROM accounts WHERE id = $1 FOR UPDATE`, [reportedId])).rows[0];
  if (!account || (account.suspended_until && account.suspended_until > now)) return;
  await client.query('UPDATE accounts SET suspended_until = $2 WHERE id = $1', [reportedId, new Date(now.getTime() + STRIKE_DAYS * DAY_MS)]);
  await client.query(
    `INSERT INTO moderation_log (account_id, public_id, action, reason, actor, created_at) VALUES ($1, $2, 'auto_suspend', $3, 'system', $4)`,
    [reportedId, account.public_id, `${rows[0].n} different readers reported this account within ${STRIKE_DAYS} days`, now],
  );
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const since = (now: Date) => new Date(now.getTime() - READER_WINDOW_DAYS * DAY_MS);
const NOT_FOUND = () => new SocialError(404, 'not found');

/** Nobody blocked by, or blocking, this viewer. */
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = a.id) OR (b.blocker_id = a.id AND b.blocked_id = $1))`;
/** Visible, and not under suspension at `$2`. */
const SHOWABLE = `a.discoverable AND (a.suspended_until IS NULL OR a.suspended_until <= $2) AND a.display_name IS NOT NULL`;

/** The number of distinct accounts that read the article, said only from 3 up. SQL fragment: `$n` is the start of the window. */
export const READER_COUNT_SQL = (articleId: string, sinceParam: string) => `(
  SELECT CASE WHEN c.n >= ${MIN_READER_COUNT} THEN c.n ELSE 0 END FROM (
    SELECT count(*)::int AS n FROM (
      SELECT account_id FROM account_reading_list WHERE article_id = ${articleId} AND NOT removed AND saved_at > ${sinceParam}
      UNION
      SELECT account_id FROM account_verifications WHERE article_id = ${articleId} AND verified_at > ${sinceParam}
    ) x
  ) c
)`;

export function createSocialStore(pool: pg.Pool): SocialStore {
  const settingsOf = (row: { discoverable: boolean; accepts_messages: boolean; adult_confirmed_at: Date | null; terms_accepted_at: Date | null }): MessagingSettings => ({
    discoverable: row.discoverable,
    accepts_messages: row.accepts_messages,
    adult_confirmed: row.adult_confirmed_at !== null,
    terms_accepted: row.terms_accepted_at !== null,
  });

  /** The viewer must be visible and not suspended themselves: you see others only while others can see you. */
  async function requireVisible(viewerId: string, now: Date) {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT (a.discoverable AND (a.suspended_until IS NULL OR a.suspended_until <= $2)) AS ok FROM accounts a WHERE a.id = $1`,
      [viewerId, now],
    );
    if (!rows[0]?.ok) throw new SocialError(403, 'visibility_required');
  }

  async function articleCount(articleId: string, now: Date): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT ${READER_COUNT_SQL('$1::uuid', '$2')} AS n`, [articleId, since(now)]);
    return rows[0].n;
  }

  async function accountByPublicId(publicId: string): Promise<{ id: string } | undefined> {
    if (!isUuid(publicId)) return undefined;
    return (await pool.query<{ id: string }>('SELECT id FROM accounts WHERE public_id = $1', [publicId.toLowerCase()])).rows[0];
  }

  return {
    async getSettings(accountId) {
      const { rows } = await pool.query(`SELECT discoverable, accepts_messages, adult_confirmed_at, terms_accepted_at FROM accounts WHERE id = $1`, [accountId]);
      if (!rows[0]) throw new SocialError(404, 'not found');
      return settingsOf(rows[0]);
    },

    async updateSettings(accountId, patch, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT discoverable, accepts_messages, adult_confirmed_at, terms_accepted_at, display_name, suspended_until FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );
        const row = rows[0];
        if (!row) throw new SocialError(404, 'not found');
        const discoverable = patch.discoverable ?? row.discoverable;
        const accepts = discoverable ? (patch.accepts_messages ?? row.accepts_messages) : false; // hiding yourself stops messages too
        const turningOn = (discoverable && !row.discoverable) || (accepts && !row.accepts_messages);
        if (turningOn) {
          if (row.suspended_until && row.suspended_until > now) throw new SocialError(403, 'suspended');
          if (accepts && !discoverable) throw new SocialError(400, 'visibility required');
          const adult = row.adult_confirmed_at !== null || patch.confirm_adult === true;
          const terms = row.terms_accepted_at !== null || patch.accept_terms === true;
          if (!adult || !terms) throw new SocialError(400, 'confirmation required');
          if (row.display_name === null) throw new SocialError(400, 'profile required');
        }
        if (patch.accepts_messages === true && !discoverable) throw new SocialError(400, 'visibility required');
        const adultAt = row.adult_confirmed_at ?? (patch.confirm_adult === true ? now : null);
        const termsAt = row.terms_accepted_at ?? (patch.accept_terms === true ? now : null);
        await client.query(`UPDATE accounts SET discoverable = $2, accepts_messages = $3, adult_confirmed_at = $4, terms_accepted_at = $5 WHERE id = $1`, [accountId, discoverable, accepts, adultAt, termsAt]);
        await client.query('COMMIT');
        return settingsOf({ discoverable, accepts_messages: accepts, adult_confirmed_at: adultAt, terms_accepted_at: termsAt });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async readersOf(viewerId, articleId, now) {
      await requireVisible(viewerId, now);
      if (!isUuid(articleId)) throw new SocialError(404, 'article not found');
      const found = await pool.query('SELECT 1 FROM articles WHERE id = $1', [articleId]);
      if (found.rowCount === 0) throw new SocialError(404, 'article not found');
      const count = await articleCount(articleId, now);

      const { rows } = await pool.query<{
        public_id: string; display_name: string; industry: string; interests: string[]; accepts_messages: boolean;
        verified_at: Date | null; saved_at: Date | null; viewer_interests: string[];
      }>(
        // $1 viewer, $2 now, $3 start of window, $4 article
        `SELECT a.public_id, a.display_name, a.industry, a.interests, a.accepts_messages,
                v.verified_at, l.saved_at, (SELECT interests FROM accounts WHERE id = $1) AS viewer_interests
         FROM accounts a
         LEFT JOIN account_verifications v ON v.account_id = a.id AND v.article_id = $4 AND v.verified_at > $3
         LEFT JOIN account_reading_list l ON l.account_id = a.id AND l.article_id = $4 AND NOT l.removed AND l.saved_at > $3
         WHERE a.id <> $1 AND ${SHOWABLE} AND ${NOT_BLOCKED} AND (v.account_id IS NOT NULL OR l.account_id IS NOT NULL)
         ORDER BY GREATEST(v.verified_at, l.saved_at) DESC
         LIMIT 200`,
        [viewerId, now, since(now), articleId],
      );
      const mine = new Set(rows[0]?.viewer_interests ?? []);
      const day = now.toISOString().slice(0, 10);
      const entries = rows.map((r) => {
        const last = Math.max(r.verified_at?.getTime() ?? 0, r.saved_at?.getTime() ?? 0);
        const theirs: string[] = r.interests ?? [];
        return {
          last,
          // A different order for each viewer each day among equals, so no one is always shown first.
          shuffle: createHash('md5').update(`${viewerId}:${day}:${r.public_id}`).digest('hex'),
          entry: {
            public_id: r.public_id,
            display_name: r.display_name,
            industry: r.industry,
            interests: theirs,
            shared_interests: theirs.filter((i) => mine.has(i)).length,
            action: r.verified_at ? 'verified' : 'saved',
            can_message: r.accepts_messages,
          } satisfies ReaderEntry,
        };
      });
      entries.sort((x, y) => y.entry.shared_interests - x.entry.shared_interests || y.last - x.last || (x.shuffle < y.shuffle ? -1 : 1));
      return { count, readers: entries.slice(0, READERS_SHOWN).map((e) => e.entry) };
    },

    async card(viewerId, publicId, now) {
      await requireVisible(viewerId, now);
      if (!isUuid(publicId)) throw NOT_FOUND();
      const { rows } = await pool.query<{ public_id: string; display_name: string; industry: string; interests: string[]; accepts_messages: boolean; verified_count: number }>(
        `SELECT a.public_id, a.display_name, a.industry, a.interests, a.accepts_messages,
                (SELECT count(*)::int FROM account_verifications v WHERE v.account_id = a.id) AS verified_count
         FROM accounts a WHERE a.public_id = $3 AND a.id <> $1 AND ${SHOWABLE} AND ${NOT_BLOCKED}`,
        [viewerId, now, publicId.toLowerCase()],
      );
      const r = rows[0];
      if (!r) throw NOT_FOUND();
      return { public_id: r.public_id, display_name: r.display_name, industry: r.industry, interests: r.interests ?? [], verified_count: r.verified_count, can_message: r.accepts_messages };
    },

    async block(accountId, publicId, now) {
      const target = await accountByPublicId(publicId);
      if (!target) throw NOT_FOUND();
      if (target.id === accountId) throw new SocialError(400, 'cannot block yourself');
      await pool.query('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [accountId, target.id, now]);
    },

    async unblock(accountId, publicId) {
      await pool.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = (SELECT id FROM accounts WHERE public_id = $2)', [accountId, publicId.toLowerCase()]);
    },

    async listBlocks(accountId) {
      const { rows } = await pool.query<BlockEntry>(
        `SELECT a.public_id, COALESCE(a.display_name, 'Reader') AS display_name, b.created_at AS blocked_at
         FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC, a.public_id`,
        [accountId],
      );
      return rows;
    },

    async report(reporterId, input, now, take) {
      const target = await accountByPublicId(input.publicId);
      if (!target) throw NOT_FOUND();
      if (target.id === reporterId) throw new SocialError(400, 'cannot report yourself');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const recent = await client.query(`SELECT 1 FROM reports WHERE reporter_id = $1 AND reported_id = $2 AND kind = 'profile' AND created_at > $3`, [reporterId, target.id, new Date(now.getTime() - DAY_MS)]);
        if (recent.rowCount === 0) {
          if (!take(reporterId)) throw new SocialError(429, 'too many reports; try again later');
          const profile = (await client.query(`SELECT public_id, display_name, industry, interests FROM accounts WHERE id = $1`, [target.id])).rows[0];
          const snapshot = { public_id: profile.public_id, display_name: profile.display_name, industry: profile.industry, interests: profile.interests ?? [], ...(input.articleId ? { article_id: input.articleId.toLowerCase() } : {}) };
          await client.query(`INSERT INTO reports (reporter_id, reported_id, kind, reason, note, snapshot, created_at) VALUES ($1, $2, 'profile', $3, $4, $5::jsonb, $6)`, [
            reporterId, target.id, input.reason, input.note ?? null, JSON.stringify(snapshot), now,
          ]);
        }
        if (recent.rowCount === 0) await maybeAutoSuspend(client, target.id, now);
        if (input.alsoBlock) await client.query('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [reporterId, target.id, now]);
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
