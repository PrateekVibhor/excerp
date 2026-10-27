import { createHash } from 'node:crypto';
import type pg from 'pg';
import { addAccountVerification, clampVerifiedAt } from './leaderboard.ts';
import { createMessageStore, type MessageStore } from './messages.ts';
import { createSocialStore, type SocialStore } from './social.ts';

export interface Account {
  id: string;
  ref: string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The short code the app shows for an account: the first 40 bits of SHA-256(sub) in Crockford base32, as EXC-XXXX-XXXX.
 * One-way, so it cannot be turned back into the Google sub, and the same for the same sub every time.
 */
export function accountRef(sub: string): string {
  const bits = [...createHash('sha256').update(sub).digest().subarray(0, 5)].map((b) => b.toString(2).padStart(8, '0')).join('');
  const code = (bits.match(/.{5}/g) ?? []).map((group) => CROCKFORD[parseInt(group, 2)]).join('');
  return `EXC-${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The profile as it syncs: the whole record, last write wins. */
export interface ProfileChange {
  display_name: string;
  industry: string;
  interests: string[];
  updated_at: string;
}
export interface ReadingListChange {
  article_id: string;
  saved_at: string;
  removed: boolean;
  updated_at: string;
}
export interface VerifiedChange {
  article_id: string;
  verified_at: string;
  topic: string;
}
export interface SyncChanges {
  profile?: ProfileChange;
  reading_list?: ReadingListChange[];
  verified?: VerifiedChange[];
}
export interface SyncResult {
  /** Where this phone is up to. Send it back next time to receive only what is newer. */
  cursor: number;
  changes: { profile: ProfileChange | null; reading_list: ReadingListChange[]; verified: VerifiedChange[] };
}
export interface SyncLimits {
  maxChanges?: number;
  maxReadingList?: number;
}
export const MAX_CHANGES = 200;
export const MAX_READING_LIST = 500;

/** The request cannot be applied (a limit, an article that does not exist). Nothing was changed. The answer is 400. */
export class InvalidChange extends Error {}
/** The account is gone, for instance deleted from another phone a moment ago. The answer is 401. */
export class AccountGone extends Error {}

export interface AccountStore extends SocialStore, MessageStore {
  /** The account for this Google sub, made if there is none. The email is refreshed, since Google accounts can change it. */
  upsert(identity: { sub: string; email: string }): Promise<Account>;
  /** The account for this Apple sub, made if there is none. It is never matched to a Google account, whatever the email. */
  upsertApple(identity: { sub: string; email: string }): Promise<Account>;
  /**
   * Applies a phone's changes and returns what is newer than its cursor, in one step. Verified articles are only ever
   * added (the earliest time wins); the reading list and the profile are last write wins by their own `updated_at`, and
   * on a tie what is stored stays. Sending the same changes again changes nothing. Throws InvalidChange, with nothing applied.
   */
  sync(accountId: string, cursor: number, changes: SyncChanges, now: Date, limits?: SyncLimits): Promise<SyncResult>;
  /**
   * Makes an old random device id the account's: its verifications join the account (counted once, the earliest time
   * wins), its entry leaves the old leaderboard, and from now on its posts are credited to the account. 'conflict' when
   * another account has it. Repeating is harmless. `folded` is how many old verifications were moved.
   */
  claimDevice(accountId: string, deviceId: string): Promise<{ folded: number } | 'conflict'>;
  /** Adds one to the account's skip count of each article listed (an article listed twice counts twice). Throws InvalidChange, counting nothing, for an article that does not exist. */
  addSkips(accountId: string, articleIds: string[]): Promise<void>;
  /**
   * What deleting the account needs to know first: its sub (Google's or Apple's, for the deletion log), which of the two it is, whether another account uses the same email, and
   * the old devices it claimed. Null when it is already gone.
   */
  forDeletion(accountId: string): Promise<{ sub: string; provider: 'google' | 'apple'; emailShared: boolean; devices: string[] } | null>;
  /** Deletes the account, and with it its profile, saved and verified articles, skip counts, device claims and sessions. */
  deleteAccount(accountId: string): Promise<void>;
}

const asTime = (iso: string) => new Date(iso).getTime();

export function createAccountStore(pool: pg.Pool): AccountStore {
  return {
    ...createSocialStore(pool), // readers, settings, blocks and reports
    ...createMessageStore(pool), // message requests and conversations

    async upsert({ sub, email }) {
      const { rows } = await pool.query<Account>(
        `INSERT INTO accounts (google_sub, ref, email) VALUES ($1, $2, $3)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, ref`,
        [sub, accountRef(sub), email],
      );
      return rows[0];
    },

    async upsertApple({ sub, email }) {
      const { rows } = await pool.query<Account>(
        `INSERT INTO accounts (apple_sub, ref, email) VALUES ($1, $2, $3)
         ON CONFLICT (apple_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, ref`,
        [sub, accountRef(`apple:${sub}`), email],
      );
      return rows[0];
    },

    async sync(accountId, cursor, changes, now, limits = {}) {
      const maxChanges = limits.maxChanges ?? MAX_CHANGES;
      const maxReadingList = limits.maxReadingList ?? MAX_READING_LIST;
      const list = changes.reading_list ?? [];
      const verified = changes.verified ?? [];
      if ((changes.profile ? 1 : 0) + list.length + verified.length > maxChanges) throw new InvalidChange(`at most ${maxChanges} changes in one request`);
      const articleIds = [...new Set([...list, ...verified].map((c) => c.article_id))];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ rev: string; profile_updated_at: Date | null }>('SELECT rev, profile_updated_at FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        if (locked.rowCount === 0) throw new AccountGone();
        let rev = Number(locked.rows[0].rev);

        if (articleIds.length > 0) {
          const found = await client.query('SELECT id FROM articles WHERE id = ANY($1::uuid[])', [articleIds]);
          if (found.rowCount !== articleIds.length) throw new InvalidChange('article_id must be the id of an article');
        }

        const p = changes.profile;
        const storedAt = locked.rows[0].profile_updated_at;
        if (p && (storedAt === null || asTime(p.updated_at) > storedAt.getTime())) {
          rev++;
          await client.query(
            'UPDATE accounts SET display_name = $2, industry = $3, interests = $4::jsonb, profile_updated_at = $5, profile_rev = $6 WHERE id = $1',
            [accountId, p.display_name, p.industry, JSON.stringify(p.interests), p.updated_at, rev],
          );
        }

        for (const c of list) {
          const { rows } = await client.query<{ updated_at: Date }>('SELECT updated_at FROM account_reading_list WHERE account_id = $1 AND article_id = $2', [accountId, c.article_id]);
          if (rows[0] && asTime(c.updated_at) <= rows[0].updated_at.getTime()) continue;
          rev++;
          await client.query(
            `INSERT INTO account_reading_list (account_id, article_id, saved_at, removed, updated_at, rev) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (account_id, article_id) DO UPDATE SET saved_at = EXCLUDED.saved_at, removed = EXCLUDED.removed, updated_at = EXCLUDED.updated_at, rev = EXCLUDED.rev`,
            [accountId, c.article_id, c.saved_at, c.removed, c.updated_at, rev],
          );
        }
        if (list.length > 0) {
          const live = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM account_reading_list WHERE account_id = $1 AND NOT removed', [accountId]);
          if (live.rows[0].n > maxReadingList) throw new InvalidChange(`at most ${maxReadingList} saved articles`);
        }

        for (const c of verified) {
          rev = (await addAccountVerification(client, accountId, c.article_id, clampVerifiedAt(c.verified_at, now), c.topic, rev)).rev;
        }

        await client.query('UPDATE accounts SET rev = $2, sync_started_at = COALESCE(sync_started_at, $3) WHERE id = $1', [accountId, rev, now]);

        const profile = await client.query<{ display_name: string; industry: string; interests: string[]; updated_at: Date }>(
          'SELECT display_name, industry, interests, profile_updated_at AS updated_at FROM accounts WHERE id = $1 AND profile_updated_at IS NOT NULL AND profile_rev > $2',
          [accountId, cursor],
        );
        const saved = await client.query<ReadingListChange>(
          'SELECT article_id, saved_at, removed, updated_at FROM account_reading_list WHERE account_id = $1 AND rev > $2 ORDER BY rev',
          [accountId, cursor],
        );
        const badges = await client.query<VerifiedChange>(
          'SELECT article_id, verified_at, topic FROM account_verifications WHERE account_id = $1 AND rev > $2 ORDER BY rev',
          [accountId, cursor],
        );
        await client.query('COMMIT');
        const row = profile.rows[0];
        return {
          cursor: rev,
          changes: {
            profile: row ? ({ display_name: row.display_name, industry: row.industry, interests: row.interests, updated_at: row.updated_at } as unknown as ProfileChange) : null,
            reading_list: saved.rows,
            verified: badges.rows,
          },
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async claimDevice(accountId, deviceId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ rev: string; display_name: string | null }>('SELECT rev, display_name FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        if (locked.rowCount === 0) throw new AccountGone();
        let rev = Number(locked.rows[0].rev);
        const claim = await client.query<{ account_id: string }>('SELECT account_id FROM device_claims WHERE device_id = $1', [deviceId]);
        if (claim.rows[0] && claim.rows[0].account_id !== accountId) {
          await client.query('ROLLBACK');
          return 'conflict';
        }
        if (!claim.rows[0]) await client.query('INSERT INTO device_claims (device_id, account_id) VALUES ($1, $2)', [deviceId, accountId]);
        const old = await client.query<{ article_id: string; verified_at: Date }>('SELECT article_id, verified_at FROM verifications WHERE device_id = $1', [deviceId]);
        const player = await client.query<{ display_name: string }>('SELECT display_name FROM players WHERE device_id = $1', [deviceId]);
        for (const row of old.rows) rev = (await addAccountVerification(client, accountId, row.article_id, row.verified_at, null, rev)).rev;
        await client.query('DELETE FROM verifications WHERE device_id = $1', [deviceId]);
        await client.query('DELETE FROM players WHERE device_id = $1', [deviceId]);
        await client.query('UPDATE accounts SET rev = $2, claimed_name = CASE WHEN display_name IS NULL THEN COALESCE($3, claimed_name) ELSE claimed_name END WHERE id = $1', [accountId, rev, player.rows[0]?.display_name ?? null]);
        await client.query('COMMIT');
        return { folded: old.rowCount ?? 0 };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async addSkips(accountId, articleIds) {
      const counts = new Map<string, number>();
      for (const id of articleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      const ids = [...counts.keys()];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT id FROM articles WHERE id = ANY($1::uuid[])', [ids]);
        if (found.rowCount !== ids.length) throw new InvalidChange('article_id must be the id of an article');
        await client.query(
          `INSERT INTO account_skips (account_id, article_id, skips)
           SELECT $1, t.id, t.n FROM unnest($2::uuid[], $3::int[]) AS t(id, n)
           ON CONFLICT (account_id, article_id) DO UPDATE SET skips = account_skips.skips + EXCLUDED.skips`,
          [accountId, ids, ids.map((id) => counts.get(id))],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async forDeletion(accountId) {
      const account = await pool.query<{ google_sub: string | null; apple_sub: string | null; shared: boolean }>(
        'SELECT google_sub, apple_sub, EXISTS (SELECT 1 FROM accounts o WHERE o.email = a.email AND o.id <> a.id) AS shared FROM accounts a WHERE a.id = $1',
        [accountId],
      );
      if (account.rowCount === 0) return null;
      const claims = await pool.query<{ device_id: string }>('SELECT device_id FROM device_claims WHERE account_id = $1', [accountId]);
      const { google_sub: google, apple_sub: apple, shared } = account.rows[0];
      return { sub: (google ?? apple)!, provider: google ? 'google' : 'apple', emailShared: shared, devices: claims.rows.map((c) => c.device_id) };
    },

    async deleteAccount(accountId) {
      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]); // the other tables follow by ON DELETE CASCADE
      // Messages the person sent stay with whoever they sent them to, and the other way round. Only what nobody is left to see goes.
      await pool.query('DELETE FROM messages WHERE sender_id IS NULL AND recipient_id IS NULL');
      await pool.query('DELETE FROM conversations WHERE initiator_id IS NULL AND recipient_id IS NULL');
    },
  };
}
