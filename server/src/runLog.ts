import type pg from 'pg';

export interface RunRecord {
  startedAt: Date;
  finishedAt: Date;
  outcome: 'ok' | 'failed';
  /** Articles stored by a run that went through. */
  stored?: number;
  /** Why a run failed. */
  error?: string;
}

export interface RunLog {
  /**
   * When the last run that went through started, or undefined when there has been none. A failed run does not count, so the
   * next start tries again. Before any run has been recorded, it is when an article was last fetched.
   */
  lastSuccessAt(): Promise<Date | undefined>;
  record(run: RunRecord): Promise<void>;
}

export function createRunLog(pool: pg.Pool): RunLog {
  return {
    async lastSuccessAt() {
      const ran = await pool.query<{ at: Date | null }>(`SELECT max(started_at) AS at FROM pipeline_runs WHERE outcome = 'ok'`);
      if (ran.rows[0].at) return ran.rows[0].at;
      // No run has been recorded yet (the first start after the record was added): the newest article is the best sign of the last run.
      const fetched = await pool.query<{ at: Date | null }>('SELECT max(fetched_at) AS at FROM articles');
      return fetched.rows[0].at ?? undefined;
    },

    async record(run) {
      await pool.query('INSERT INTO pipeline_runs (started_at, finished_at, outcome, stored, error) VALUES ($1, $2, $3, $4, $5)', [
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.outcome === 'ok' ? run.stored ?? null : null,
        run.outcome === 'failed' ? run.error ?? null : null,
      ]);
    },
  };
}
