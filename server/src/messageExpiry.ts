import type pg from 'pg';
import { MESSAGE_DAYS, REQUEST_DAYS } from './messages.ts';

/** A report that has been dealt with is kept this long, then removed. An open one is kept. */
export const HANDLED_REPORT_DAYS = 90;
const DAY_MS = 86_400_000;

export interface PurgeResult {
  /** Requests nobody answered for 30 days, now marked expired. */
  expiredRequests: number;
  /** Messages past 12 months, deleted. */
  deletedMessages: number;
  /** Conversations left with no messages, or with nobody in them, deleted. */
  deletedConversations: number;
  /** Reports dealt with more than 90 days ago, deleted. */
  deletedReports: number;
}

/**
 * The clean-up that makes the time limits true: unanswered requests close after 30 days, every message goes 12 months after it was
 * sent, a conversation goes with its last message (or when both people have left), and handled reports go after 90 days. Reads
 * already ignore what is past its time, so this only has to keep the database tidy. Safe to run as often as you like.
 */
export async function purgeExpired(pool: pg.Pool, now: Date): Promise<PurgeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `UPDATE conversations SET state = 'expired', state_seq = nextval('inbox_seq') WHERE state = 'request' AND created_at <= $1`,
      [new Date(now.getTime() - REQUEST_DAYS * DAY_MS)],
    );
    // A message nobody on either side still has an account for is gone too, whatever its age.
    const messages = await client.query(`DELETE FROM messages WHERE expires_at <= $1 OR (sender_id IS NULL AND recipient_id IS NULL)`, [now]);
    const conversations = await client.query(
      `DELETE FROM conversations c WHERE (c.initiator_id IS NULL AND c.recipient_id IS NULL) OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
    );
    const reports = await client.query(`DELETE FROM reports WHERE status <> 'open' AND handled_at IS NOT NULL AND handled_at <= $1`, [new Date(now.getTime() - HANDLED_REPORT_DAYS * DAY_MS)]);
    await client.query('COMMIT');
    void MESSAGE_DAYS;
    return { expiredRequests: expired.rowCount ?? 0, deletedMessages: messages.rowCount ?? 0, deletedConversations: conversations.rowCount ?? 0, deletedReports: reports.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
