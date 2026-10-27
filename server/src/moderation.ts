import type pg from 'pg';

const DAY_MS = 86_400_000;
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface ReportSummary {
  id: string;
  created_at: Date;
  kind: 'profile' | 'message';
  reason: string;
  note: string | null;
  status: string;
  /** Who was reported: from their account if it still exists, else from the frozen copy. */
  reported: { public_id: string | null; display_name: string | null } | null;
  message_id: string | null;
  snapshot: Record<string, any>;
}
export interface LogEntry {
  id: number;
  action: string;
  actor: 'owner' | 'system';
  reason: string;
  public_id: string | null;
  created_at: Date;
}

export interface Moderation {
  /** Reports still open, oldest first. */
  openReports(): Promise<ReportSummary[]>;
  showReport(id: string): Promise<ReportSummary | undefined>;
  /** Hides the reader and stops their messaging for this many days. False if there is no such reader. */
  suspend(publicId: string, days: number, reason: string, now: Date): Promise<boolean>;
  unsuspend(publicId: string, reason: string, now: Date): Promise<boolean>;
  /** Ends access: off the list, sessions gone, never signed in again, hidden. */
  ban(publicId: string, reason: string, now: Date): Promise<boolean>;
  /** False if the report is unknown or already dealt with. */
  resolveReport(id: string, status: 'resolved' | 'dismissed', action: string, now: Date): Promise<boolean>;
  /** Deletes a message for both people. The conversation goes with its last message. False if there is no such message. */
  deleteMessage(messageId: string, reason: string, now: Date): Promise<boolean>;
  /** The latest actions, newest first. */
  log(limit: number): Promise<LogEntry[]>;
}

export function createModeration(pool: pg.Pool): Moderation {
  const record = (
    client: pg.PoolClient | pg.Pool,
    e: { accountId?: string | null; publicId?: string | null; action: string; reason: string; detail?: unknown; now: Date },
  ) =>
    client.query(`INSERT INTO moderation_log (account_id, public_id, action, reason, actor, detail, created_at) VALUES ($1, $2, $3, $4, 'owner', $5::jsonb, $6)`, [
      e.accountId ?? null, e.publicId ?? null, e.action, e.reason, e.detail === undefined ? null : JSON.stringify(e.detail), e.now,
    ]);

  const account = async (publicId: string) =>
    isUuid(publicId) ? (await pool.query<{ id: string; email: string; public_id: string }>('SELECT id, email, public_id FROM accounts WHERE public_id = $1', [publicId.toLowerCase()])).rows[0] : undefined;

  const REPORT = `SELECT r.id, r.created_at, r.kind, r.reason, r.note, r.status, r.message_id, r.snapshot, a.public_id AS a_public_id, a.display_name AS a_name
                  FROM reports r LEFT JOIN accounts a ON a.id = r.reported_id`;
  const summary = (r: any): ReportSummary => {
    const fromSnapshot = r.snapshot?.sender ?? (r.kind === 'profile' ? r.snapshot : null);
    return {
      id: r.id, created_at: r.created_at, kind: r.kind, reason: r.reason, note: r.note, status: r.status, message_id: r.message_id, snapshot: r.snapshot,
      reported: r.a_public_id ? { public_id: r.a_public_id, display_name: r.a_name } : fromSnapshot ? { public_id: fromSnapshot.public_id ?? null, display_name: fromSnapshot.display_name ?? null } : null,
    };
  };

  return {
    async openReports() {
      return (await pool.query(`${REPORT} WHERE r.status = 'open' ORDER BY r.created_at, r.id`)).rows.map(summary);
    },

    async showReport(id) {
      if (!isUuid(id)) return undefined;
      const r = (await pool.query(`${REPORT} WHERE r.id = $1`, [id.toLowerCase()])).rows[0];
      return r ? summary(r) : undefined;
    },

    async suspend(publicId, days, reason, now) {
      const a = await account(publicId);
      if (!a) return false;
      await pool.query('UPDATE accounts SET suspended_until = $2 WHERE id = $1', [a.id, new Date(now.getTime() + days * DAY_MS)]);
      await record(pool, { accountId: a.id, publicId: a.public_id, action: 'suspend', reason, detail: { days }, now });
      return true;
    },

    async unsuspend(publicId, reason, now) {
      const a = await account(publicId);
      if (!a) return false;
      await pool.query('UPDATE accounts SET suspended_until = NULL WHERE id = $1 AND banned_at IS NULL', [a.id]);
      await record(pool, { accountId: a.id, publicId: a.public_id, action: 'unsuspend', reason, now });
      return true;
    },

    async ban(publicId, reason, now) {
      const a = await account(publicId);
      if (!a) return false;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM allowed_emails WHERE email = $1', [a.email]);
        await client.query('DELETE FROM sessions WHERE account_id = $1 OR email = $2', [a.id, a.email]);
        await client.query(
          `UPDATE accounts SET banned_at = COALESCE(banned_at, $2), suspended_until = 'infinity', discoverable = false, accepts_messages = false WHERE id = $1`,
          [a.id, now],
        );
        await record(client, { accountId: a.id, publicId: a.public_id, action: 'ban', reason, now });
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async resolveReport(id, status, action, now) {
      if (!isUuid(id)) return false;
      const { rows } = await pool.query<{ reported_id: string | null }>(
        `UPDATE reports SET status = $2, action = $3, handled_at = $4 WHERE id = $1 AND status = 'open' RETURNING reported_id`,
        [id.toLowerCase(), status, action, now],
      );
      if (rows.length === 0) return false;
      await record(pool, { accountId: rows[0].reported_id, action: 'resolve', reason: action, detail: { report_id: id.toLowerCase(), status }, now });
      return true;
    },

    async deleteMessage(messageId, reason, now) {
      if (!isUuid(messageId)) return false;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const gone = await client.query<{ conversation_id: string; sender_id: string | null }>('DELETE FROM messages WHERE id = $1 RETURNING conversation_id, sender_id', [messageId.toLowerCase()]);
        if (gone.rowCount === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('DELETE FROM conversations c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)', [gone.rows[0].conversation_id]);
        await record(client, { accountId: gone.rows[0].sender_id, action: 'delete_message', reason, detail: { message_id: messageId.toLowerCase() }, now });
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async log(limit) {
      return (await pool.query<LogEntry>(`SELECT id, action, actor, reason, public_id, created_at FROM moderation_log ORDER BY created_at DESC, id DESC LIMIT $1`, [Math.max(1, Math.min(limit, 500))])).rows;
    },
  };
}
