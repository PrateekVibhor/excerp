// Plan 16: building and publishing course versions (spec 16, sections 4 and 6.1). A new version is made beside the live one and replaces
// it in one transaction, so readers never see a half-checked version; a failed version changes nothing for them.
import type pg from 'pg';

export type VersionErrorCode = 'not_found' | 'busy' | 'not_building' | 'withdrawn' | 'cancelled';

export class VersionError extends Error {
  readonly code: VersionErrorCode;
  constructor(code: VersionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PublishOptions {
  /** Set when the version is the owner's corrected course: it may publish over a withdrawal, which it clears. */
  correction?: boolean;
  /** What the build learned about the course, written in the same transaction. */
  course?: { poolSize?: number; evidenceThin?: boolean; nextCheckAt?: Date | null; lastCheckedAt?: Date };
}

/** Starts the next version of a course inside a transaction the caller owns (used when approving a course). */
export async function startVersionOn(client: pg.PoolClient, courseId: string, opts: { model?: string; runId?: number }, at: Date): Promise<{ id: string; version: number }> {
  if (!(await client.query(`SELECT id FROM courses WHERE id = $1 FOR UPDATE`, [courseId])).rows[0]) throw new VersionError('not_found', 'no such course');
  if ((await client.query(`SELECT 1 FROM course_versions WHERE course_id = $1 AND status = 'building'`, [courseId])).rowCount) throw new VersionError('busy', 'a version of this course is already being built');
  const { rows } = await client.query(
    `INSERT INTO course_versions (course_id, version, status, model, run_id, created_at)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM course_versions WHERE course_id = $1), 'building', $2, $3, $4) RETURNING id, version`,
    [courseId, opts.model ?? null, opts.runId ?? null, at],
  );
  return { id: rows[0].id as string, version: rows[0].version as number };
}

export function createVersionStore(pool: pg.Pool, now: () => Date = () => new Date()) {
  async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Finds a version's course, locks the course (so builds of one course take turns), then reads the version and course again. */
  async function lock(client: pg.PoolClient, versionId: string) {
    const found = await client.query(`SELECT course_id FROM course_versions WHERE id = $1`, [versionId]);
    if (!found.rows[0]) throw new VersionError('not_found', 'no such version');
    const courseId: string = found.rows[0].course_id;
    const course = (await client.query(`SELECT status, published_version FROM courses WHERE id = $1 FOR UPDATE`, [courseId])).rows[0];
    // The reader cancelled the list: a build still running for it may not publish or fail anything. The row is locked, so a cancel and a publish take turns and only one wins.
    if (course.status === 'cancelled') throw new VersionError('cancelled', 'cancelled: by the reader');
    const version = (await client.query(`SELECT status FROM course_versions WHERE id = $1`, [versionId])).rows[0];
    if (version.status !== 'building') throw new VersionError('not_building', `version is ${version.status}, not building`);
    return { courseId, course: course as { status: string; published_version: string | null } };
  }

  return {
    /** Starts the next version of a course. Only one is built at a time; numbers keep rising past failed ones. */
    start: (courseId: string, opts: { model?: string; runId?: number } = {}) => inTransaction((client) => startVersionOn(client, courseId, opts, now())),

    /** Makes a version the live one, in one transaction: the old one is superseded, its changes become visible, the course is ready. */
    publish: (versionId: string, opts: PublishOptions = {}) =>
      inTransaction(async (client) => {
        const { courseId, course } = await lock(client, versionId);
        if (course.status === 'withdrawn' && !opts.correction) throw new VersionError('withdrawn', 'the course is withdrawn');
        const at = now();
        await client.query(`UPDATE course_versions SET status = 'superseded' WHERE course_id = $1 AND status = 'published'`, [courseId]);
        await client.query(`UPDATE course_versions SET status = 'published', published_at = $2 WHERE id = $1`, [versionId, at]);
        await client.query(`UPDATE course_changes SET published_at = $2 WHERE version_id = $1 AND published_at IS NULL`, [versionId, at]);

        const set = ['published_version = $2', `status = 'ready'`, 'failure_reason = NULL', 'generated_at = $3'];
        const args: unknown[] = [courseId, versionId, at];
        const add = (column: string, value: unknown) => void (args.push(value), set.push(`${column} = $${args.length}`));
        if (opts.correction) set.push('withdrawn_at = NULL', 'withdrawal_note = NULL');
        const c = opts.course ?? {};
        if (c.poolSize !== undefined) add('pool_size', c.poolSize);
        if (c.evidenceThin !== undefined) add('evidence_thin', c.evidenceThin);
        if (c.nextCheckAt !== undefined) add('next_check_at', c.nextCheckAt);
        if (c.lastCheckedAt !== undefined) add('last_checked_at', c.lastCheckedAt);
        await client.query(`UPDATE courses SET ${set.join(', ')} WHERE id = $1`, args);
      }),

    /** Marks a version failed. Readers keep what they had; a course that never had a live version ends failed with the reason. */
    fail: (versionId: string, reason: string) =>
      inTransaction(async (client) => {
        const { courseId, course } = await lock(client, versionId);
        await client.query(`UPDATE course_versions SET status = 'failed' WHERE id = $1`, [versionId]);
        if (course.published_version === null && course.status === 'building') await client.query(`UPDATE courses SET status = 'failed', failure_reason = $2 WHERE id = $1`, [courseId, reason]);
      }),
  };
}
