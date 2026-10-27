import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { normalizeEmail } from './auth.ts';

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface AllowedEmail {
  email: string;
  added_at: Date;
}
export interface PendingRequest {
  email: string;
  first_requested_at: Date;
  last_requested_at: Date;
}
export interface Session {
  email: string;
  expires_at: Date;
  /** The account this session belongs to; null for a session made before accounts existed. */
  account_id: string | null;
  account_ref: string | null;
}

export interface AuthStore {
  /** Whether the email is on the allow-list. Throws RangeError for text that is not an email address. */
  isAllowed(email: string): Promise<boolean>;
  /** Puts the email on the list and clears its waiting request. False when it was already there. */
  addAllowed(email: string): Promise<boolean>;
  /** False when it was not on the list. */
  removeAllowed(email: string): Promise<boolean>;
  listAllowed(): Promise<AllowedEmail[]>;
  /** Remembers that this email signed in and was not approved: the email and the time, nothing else. */
  recordRequest(email: string, now?: Date): Promise<void>;
  /** Emails that asked for access and are not on the list, newest request first. */
  listPending(): Promise<PendingRequest[]>;
  /** Makes a session. The token is returned once; only its hash is stored. Expired sessions are cleared out. */
  createSession(email: string, now?: Date, accountId?: string): Promise<{ token: string; expires_at: Date }>;
  /** The session for a token, or null when there is none or it has expired. A session in use lasts 30 days from the use. */
  findSession(token: string, now?: Date): Promise<Session | null>;
  /** Removes the session. Nothing happens, and nothing fails, when it is already gone. */
  deleteSession(token: string): Promise<void>;
  /** Removes everything kept under the email: its sessions, its place on the allow-list and its waiting request. Safe to repeat. */
  deleteAccount(email: string): Promise<void>;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const must = (email: string) => {
  const normalized = normalizeEmail(email);
  if (normalized === null) throw new RangeError('not an email address');
  return normalized;
};

export function createAuthStore(pool: pg.Pool): AuthStore {
  return {
    async isAllowed(email) {
      const { rowCount } = await pool.query('SELECT 1 FROM allowed_emails WHERE email = $1', [must(email)]);
      return rowCount === 1;
    },

    async addAllowed(email) {
      const address = must(email);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query('INSERT INTO allowed_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [address]);
        await client.query('DELETE FROM access_requests WHERE email = $1', [address]);
        await client.query('COMMIT');
        return rowCount === 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async removeAllowed(email) {
      const { rowCount } = await pool.query('DELETE FROM allowed_emails WHERE email = $1', [must(email)]);
      return rowCount === 1;
    },

    async listAllowed() {
      return (await pool.query<AllowedEmail>('SELECT email, added_at FROM allowed_emails ORDER BY email')).rows;
    },

    async recordRequest(email, now = new Date()) {
      await pool.query(
        `INSERT INTO access_requests (email, first_requested_at, last_requested_at) VALUES ($1, $2, $2)
         ON CONFLICT (email) DO UPDATE SET last_requested_at = EXCLUDED.last_requested_at`,
        [must(email), now],
      );
    },

    async listPending() {
      return (
        await pool.query<PendingRequest>(
          `SELECT r.email, r.first_requested_at, r.last_requested_at FROM access_requests r
           WHERE NOT EXISTS (SELECT 1 FROM allowed_emails a WHERE a.email = r.email) ORDER BY r.last_requested_at DESC, r.email`,
        )
      ).rows;
    },

    async createSession(email, now = new Date(), accountId) {
      const token = randomBytes(32).toString('base64url');
      const expires_at = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
      await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
      await pool.query('INSERT INTO sessions (token_hash, email, created_at, expires_at, account_id) VALUES ($1, $2, $3, $4, $5)', [hash(token), must(email), now, expires_at, accountId ?? null]);
      return { token, expires_at };
    },

    async findSession(token, now = new Date()) {
      if (typeof token !== 'string' || token === '') return null;
      const tokenHash = hash(token);
      const { rows } = await pool.query<Session>(
        'SELECT s.email, s.expires_at, s.account_id, a.ref AS account_ref FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1',
        [tokenHash],
      );
      const session = rows[0];
      if (!session) return null;
      if (session.expires_at.getTime() <= now.getTime()) {
        await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
        return null;
      }
      // In use: expire 30 days from now, but move the date at most once a day, so a busy session is not written on every request.
      const renewed = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
      if (renewed.getTime() - session.expires_at.getTime() >= DAY_MS) {
        await pool.query('UPDATE sessions SET expires_at = $2 WHERE token_hash = $1', [tokenHash, renewed]);
        return { ...session, expires_at: renewed };
      }
      return session;
    },

    async deleteSession(token) {
      if (typeof token !== 'string' || token === '') return;
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    },

    async deleteAccount(email) {
      const address = must(email);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM allowed_emails WHERE email = $1', [address]);
        await client.query('DELETE FROM access_requests WHERE email = $1', [address]);
        await client.query('DELETE FROM sessions WHERE email = $1', [address]);
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
