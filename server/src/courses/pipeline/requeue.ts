// Plan 16, phase 4: queue a failed build again without asking the reader to approve twice. Only a course that was approved and ended failed
// (never published) can be queued; a new version and a new queued run are made and the course goes back to building.
import type pg from 'pg';

export async function requeueBuild(pool: pg.Pool, courseId: string, now: () => Date = () => new Date()): Promise<{ versionId: string; runId: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = (await client.query(`SELECT status, approved_at, published_version FROM courses WHERE id = $1 FOR UPDATE`, [courseId])).rows[0];
    if (!c) throw new Error('no such course');
    if (c.status !== 'failed' || !c.approved_at || c.published_version) throw new Error(`only a failed course that was approved can be queued again (status ${c.status})`);
    const v = (await client.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM course_versions WHERE course_id = $1), 'building') RETURNING id`, [courseId])).rows[0].id as string;
    const run = (await client.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, v, now()])).rows[0].id as number;
    await client.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [v, run]);
    await client.query(`UPDATE courses SET status = 'building', failure_reason = NULL WHERE id = $1`, [courseId]);
    await client.query('COMMIT');
    return { versionId: v, runId: run };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
