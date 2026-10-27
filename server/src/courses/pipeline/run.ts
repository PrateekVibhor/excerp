// Plan 16, phase 4: the runner. Stages run in order against one shared context; each is recorded in course_runs with its progress, the
// Tavily credits and tokens it used, and a failing stage ends the run with its name and reason. The runner does not decide a version's fate
// (publishing and failing a version are their own steps), so a failed run leaves everything readers can see as it was.
import type pg from 'pg';

export interface RunIO {
  /** Counts Tavily credits; throws, before the caller spends, if the run's credit budget would be passed. */
  credits(n: number): void;
  tokens(input: number, output: number): void;
}

export interface Stage<C> {
  name: string;
  run(ctx: C, io: RunIO): Promise<void>;
}

export interface RunOptions {
  courseId: string;
  versionId?: string;
  kind: 'source_finding' | 'generation' | 'refresh' | 'correction';
  requestedBy?: string;
  /** A run approval already queued; it is taken over instead of a new one being made. */
  runId?: number;
  now?: () => Date;
  /** Called after each stage that ran, with what that stage alone used. */
  onStage?: (report: { stage: string; credits: number; tokensIn: number; tokensOut: number; failed: boolean }) => void;
  /** Called as each stage begins. */
  onStageStart?: (stage: string) => void;
  /** The most Tavily credits this run may use. */
  creditBudget?: number;
  /** Called before each stage; throwing stops the run there, as a failed stage (the build uses it to notice a cancel or a delete). */
  checkpoint?: () => Promise<void>;
}

export type RunResult = { ok: true; runId: number } | { ok: false; runId: number; stage: string; reason: string };

export async function runStages<C>(pool: pg.Pool, opts: RunOptions, stages: Stage<C>[], ctx: C): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const runId: number =
    opts.runId ??
    (
      await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, started_at) VALUES ($1, $2, $3, $4, '', $5) RETURNING id`, [opts.courseId, opts.versionId ?? null, opts.kind, opts.requestedBy ?? null, now()])
    ).rows[0].id;
  const used = { credits: 0, tokensIn: 0, tokensOut: 0 };
  const io: RunIO = {
    credits(n) {
      if (opts.creditBudget !== undefined && used.credits + n > opts.creditBudget) throw new Error(`the credit budget of ${opts.creditBudget} would be passed (${used.credits} used, ${n} more asked for)`);
      used.credits += n;
    },
    tokens(input, output) {
      used.tokensIn += input;
      used.tokensOut += output;
    },
  };
  const save = (stage: string, percent: number, finished?: Date, error?: string) =>
    pool.query(`UPDATE course_runs SET stage = $2, percent = $3, tavily_credits = $4, tokens_in = $5, tokens_out = $6, finished_at = $7, error = $8 WHERE id = $1`, [
      runId, stage, percent, used.credits, used.tokensIn, used.tokensOut, finished ?? null, error ?? null,
    ]);

  for (const [i, stage] of stages.entries()) {
    await save(stage.name, Math.floor((i * 100) / stages.length));
    opts.onStageStart?.(stage.name);
    const before = { ...used };
    const report = (failed: boolean) => opts.onStage?.({ stage: stage.name, credits: used.credits - before.credits, tokensIn: used.tokensIn - before.tokensIn, tokensOut: used.tokensOut - before.tokensOut, failed });
    try {
      await opts.checkpoint?.();
      await stage.run(ctx, io);
      report(false);
    } catch (error) {
      report(true);
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await save(stage.name, Math.floor((i * 100) / stages.length), now(), reason);
      return { ok: false, runId, stage: stage.name, reason };
    }
  }
  await save(stages.at(-1)?.name ?? '', 100, now());
  return { ok: true, runId };
}
