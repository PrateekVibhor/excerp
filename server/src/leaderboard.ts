import type pg from 'pg';
import { OTHER_TOPIC } from '../../src/data/types.ts';

/** What the app sends for one verification (spec-9). Checked by the endpoint before it gets here. */
export interface SyncVerification {
  device_id: string;
  display_name: string;
  article_id: string;
  verified_at: string;
}

export interface LeaderboardRow {
  rank: number;
  display_name: string;
  count: number;
  is_you: boolean;
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  /** The caller's own row with their true rank, even beyond the rows returned; null when they are not on the board. */
  you: LeaderboardRow | null;
}

export const LEADERBOARD_SIZE = 50;
/** A device clock this far ahead is believed; further ahead and the server's own time is used. */
export const MAX_CLOCK_AHEAD_MS = 5 * 60_000;

/**
 * The time a verification counts as made. A device whose clock runs more than 5 minutes ahead would otherwise sit
 * at the bottom of every tie for good, so its claim is replaced by the server's time. Throws on text that is not a date.
 */
export function clampVerifiedAt(verifiedAt: string, now: Date): Date {
  const claimed = new Date(verifiedAt);
  if (Number.isNaN(claimed.getTime())) throw new RangeError('verified_at is not a date');
  return claimed.getTime() - now.getTime() > MAX_CLOCK_AHEAD_MS ? now : claimed;
}

/**
 * Adds a verified article to an account, keeping the earliest time: a later one changes nothing. A null topic keeps the
 * topic already there, or files a new record under "Other" (an old device never recorded one). Returns the account's
 * new revision, and whether the article was new to the account.
 */
export async function addAccountVerification(client: pg.PoolClient, accountId: string, articleId: string, at: Date, topic: string | null, rev: number): Promise<{ rev: number; isNew: boolean }> {
  const { rows } = await client.query<{ verified_at: Date }>('SELECT verified_at FROM account_verifications WHERE account_id = $1 AND article_id = $2', [accountId, articleId]);
  const existing = rows[0];
  if (existing && at.getTime() >= existing.verified_at.getTime()) return { rev, isNew: false };
  rev++;
  await client.query(
    `INSERT INTO account_verifications (account_id, article_id, verified_at, topic, rev) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, article_id) DO UPDATE SET verified_at = EXCLUDED.verified_at, topic = COALESCE($6, account_verifications.topic), rev = EXCLUDED.rev`,
    [accountId, articleId, at, topic ?? OTHER_TOPIC, rev, topic],
  );
  return { rev, isNew: existing === undefined };
}

export interface LeaderboardStore {
  /**
   * Remembers the player's name and counts the verification. Resolves true when it was new and false when this
   * device had already verified this article, in which case nothing changes except the name. Rejects, changing
   * nothing, when the article does not exist.
   */
  record(verification: SyncVerification, now?: Date): Promise<boolean>;
  /** The top rows, and when a device id is given, that device's own row and true rank. */
  leaderboard(deviceId?: string, limit?: number, accountId?: string): Promise<LeaderboardResponse>;
  /** Removes the device's player and all its verifications, in one step. Nothing happens, and nothing fails, when there are none. */
  deleteDevice(deviceId: string): Promise<void>;
}

export function createLeaderboardStore(pool: pg.Pool): LeaderboardStore {
  return {
    async record(v, now = new Date()) {
      const verifiedAt = clampVerifiedAt(v.verified_at, now);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // A device an account has claimed: the verification is the account's. An older app keeps posting this way.
        const claim = await client.query<{ account_id: string }>('SELECT account_id FROM device_claims WHERE device_id = $1', [v.device_id]);
        if (claim.rows[0]) {
          const accountId = claim.rows[0].account_id;
          const locked = await client.query<{ rev: string }>('SELECT rev FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
          const added = await addAccountVerification(client, accountId, v.article_id, verifiedAt, null, Number(locked.rows[0].rev));
          await client.query('UPDATE accounts SET rev = $2, claimed_name = CASE WHEN display_name IS NULL THEN $3 ELSE claimed_name END WHERE id = $1', [accountId, added.rev, v.display_name]);
          await client.query('COMMIT');
          return added.isNew;
        }
        await client.query(
          `INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (device_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at`,
          [v.device_id, v.display_name, now],
        );
        const { rowCount } = await client.query(
          `INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, $3)
           ON CONFLICT (device_id, article_id) DO NOTHING`,
          [v.device_id, v.article_id, verifiedAt],
        );
        await client.query('COMMIT');
        return rowCount === 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteDevice(deviceId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM verifications WHERE device_id = $1', [deviceId]);
        await client.query('DELETE FROM players WHERE device_id = $1', [deviceId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async leaderboard(deviceId, limit = LEADERBOARD_SIZE, accountId) {
      // Who is ranked: accounts (named by their profile, an old device's name, or "Reader") and devices nobody has claimed.
      // Most verified articles first; among equal counts, whoever made their latest verification earlier reached that
      // count first. The id only settles exact ties, so the order never changes between calls.
      const you = accountId ? `a:${accountId}` : deviceId ? `d:${deviceId}` : null;
      const { rows } = await pool.query<LeaderboardRow>(
        `WITH entries AS (
           SELECT 'd:' || v.device_id AS key, p.display_name, count(*)::int AS count, max(v.verified_at) AS latest, v.device_id AS tie
           FROM verifications v JOIN players p ON p.device_id = v.device_id GROUP BY v.device_id, p.display_name
           UNION ALL
           SELECT 'a:' || a.id::text, COALESCE(a.display_name, a.claimed_name, 'Reader'), count(*)::int, max(av.verified_at), a.id::text
           FROM account_verifications av JOIN accounts a ON a.id = av.account_id GROUP BY a.id
         ), ranked AS (
           SELECT *, row_number() OVER (ORDER BY count DESC, latest ASC, tie ASC)::int AS rank FROM entries
         )
         SELECT rank, display_name, count, COALESCE(key = $2::text, false) AS is_you
         FROM ranked WHERE rank <= $1 OR key = $2::text ORDER BY rank`,
        [limit, you],
      );
      return { rows: rows.filter((r) => r.rank <= limit), you: rows.find((r) => r.is_you) ?? null };
    },
  };
}
