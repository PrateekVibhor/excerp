// One-off: gives articles stored before Feature 8 a quiz and a topic.
//
//   npm run backfill                          dry run: counts and estimated cost, changes nothing
//   npm run backfill -- --apply --limit 20    makes quizzes for at most 20 articles
//   options: --limit N (default 25)  --batch-size N (default 5)  --apply
//
// Only articles whose quiz is null are touched. An existing quiz is never replaced and no article is
// ever deleted. An article whose quiz cannot be made keeps a null quiz and is tried again next run.
import { loadConfig } from './config.ts';
import { createBackfillStore, createDb, type BackfillStore } from './db.ts';
import { createNebiusChat } from './llm.ts';
import type { LogEvent } from './pipeline.ts';
import { generateQuiz, type QuizGeneration } from './quiz.ts';

export const DEFAULT_LIMIT = 25;
export const DEFAULT_BATCH_SIZE = 5;

// Measured on the live model (Oct 2026, ten real summaries, quiz writer plus the answer check): 25 model calls and
// 51,585 tokens (12,465 sent, 39,120 received, mostly hidden reasoning) for 10 articles, with the retries that
// happened. That is the expected cost of an article. The 14 quiz attempts in that run cost about 3,700 tokens each,
// counting the check on the attempts that reached it; an article that uses all 3 attempts costs about 3 times that.
export const EST_TOKENS_PER_ARTICLE = 5160;
export const EST_TOKENS_PER_ATTEMPT = 3700;
export const MAX_ATTEMPTS = 3;

export interface Estimate {
  articles: number;
  /** The measured average per article, retries included. */
  expectedTokens: number;
  /** Every article needs all 3 attempts. */
  worstCaseTokens: number;
}

export function estimateTokens(articles: number): Estimate {
  return { articles, expectedTokens: articles * EST_TOKENS_PER_ARTICLE, worstCaseTokens: articles * MAX_ATTEMPTS * EST_TOKENS_PER_ATTEMPT };
}

export interface BackfillOptions {
  store: BackfillStore;
  makeQuiz: (summary: string) => Promise<QuizGeneration>;
  /** False (the default) is a dry run: nothing is written and the model is never called. */
  apply?: boolean;
  limit?: number;
  batchSize?: number;
  /** Waits between batches; replaced in tests. */
  pause?: () => Promise<void>;
  log: (event: LogEvent) => void;
}

export interface BackfillReport {
  mode: 'dry run' | 'apply';
  /** Articles without a quiz when the run started. */
  missing: number;
  /** How many this run would handle, or did try: the smaller of missing and the limit. */
  planned: number;
  estimate: Estimate;
  stored: number;
  failed: number;
  /** Quiz made, but the article got one in the meantime, so it was left alone. */
  alreadyHadQuiz: number;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const { store, makeQuiz, apply = false, limit = DEFAULT_LIMIT, batchSize = DEFAULT_BATCH_SIZE, log, pause = () => new Promise((r) => setTimeout(r, 1000)) } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a whole number of at least 1');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batch size must be a whole number of at least 1');

  const missing = await store.countMissing();
  const planned = Math.min(missing, limit);
  const report: BackfillReport = { mode: apply ? 'apply' : 'dry run', missing, planned, estimate: estimateTokens(planned), stored: 0, failed: 0, alreadyHadQuiz: 0 };
  log({ event: 'backfill_started', mode: report.mode, missing, planned, limit, batchSize, estimatedTokens: report.estimate.expectedTokens, worstCaseTokens: report.estimate.worstCaseTokens });
  if (!apply) {
    log({ event: 'backfill_finished', mode: report.mode, stored: 0, failed: 0, note: 'dry run: nothing was changed and the model was not called' });
    return report;
  }

  let afterId: string | undefined;
  let tried = 0;
  while (tried < planned) {
    const batch = await store.listMissing(Math.min(batchSize, planned - tried), afterId);
    if (batch.length === 0) break;
    for (const article of batch) {
      tried++;
      afterId = article.id;
      let made: QuizGeneration;
      try {
        made = await makeQuiz(article.summary);
      } catch (error) {
        made = { ok: false, reason: `quiz step failed: ${(error as Error).message}`, attempts: 0, failures: [`quiz step failed: ${(error as Error).message}`] };
      }
      if (!made.ok) {
        report.failed++;
        log({ event: 'backfill_failed', id: article.id, url: article.source_url, attempts: made.attempts, failures: made.failures });
        continue; // quiz stays null; the next run tries again
      }
      if (made.failures.length > 0) log({ event: 'backfill_retried', id: article.id, url: article.source_url, failures: made.failures });
      if (await store.setQuiz(article.id, made.value.quiz, made.value.topic)) {
        report.stored++;
        log({ event: 'backfill_stored', id: article.id, url: article.source_url, topic: made.value.topic, attempts: made.attempts });
      } else {
        report.alreadyHadQuiz++;
        log({ event: 'backfill_skipped', id: article.id, url: article.source_url, reason: 'already has a quiz' });
      }
    }
    if (tried < planned) await pause();
  }
  log({ event: 'backfill_finished', mode: report.mode, stored: report.stored, failed: report.failed, alreadyHadQuiz: report.alreadyHadQuiz });
  return report;
}

/** Reads --apply, --limit N and --batch-size N. Anything else is an error, so a typo cannot start a real run. */
export function parseArgs(argv: string[]): { apply: boolean; limit: number; batchSize: number } {
  const out = { apply: false, limit: DEFAULT_LIMIT, batchSize: DEFAULT_BATCH_SIZE };
  const number = (flag: string, value: string | undefined) => {
    if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`${flag} needs a whole number of at least 1`);
    return Number(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--limit') out.limit = number(arg, argv[++i]);
    else if (arg === '--batch-size') out.batchSize = number(arg, argv[++i]);
    else throw new Error(`unknown option ${arg}. Options: --apply, --limit N, --batch-size N`);
  }
  return out;
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const chat = createNebiusChat({ apiKey: config.nebiusApiKey, model: config.nebiusModel });
  try {
    const report = await runBackfill({
      store: createBackfillStore(db.pool),
      makeQuiz: (summary) => generateQuiz(summary, chat),
      ...args,
      log: (event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })),
    });
    console.log(JSON.stringify({ event: 'report', ...report }));
  } finally {
    await db.close();
  }
}
