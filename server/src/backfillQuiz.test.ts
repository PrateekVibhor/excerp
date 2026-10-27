import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Quiz } from '../../src/data/types.ts';
import type { BackfillStore, MissingQuiz } from './db.ts';
import type { Chat } from './llm.ts';
import { DEFAULT_BATCH_SIZE, DEFAULT_LIMIT, EST_TOKENS_PER_ARTICLE, EST_TOKENS_PER_ATTEMPT, estimateTokens, MAX_ATTEMPTS, parseArgs, runBackfill } from './backfillQuiz.ts';
import type { LogEvent } from './pipeline.ts';
import { generateQuiz, type QuizGeneration } from './quiz.ts';

const QUIZ: Quiz = { questions: [0, 1, 2].map((n) => ({ prompt: `Q${n}?`, options: ['a', 'b', 'c', 'd'].map((o) => `${o}${n}`), correct_index: n })) };
const OLD_QUIZ: Quiz = { questions: [0, 1, 2].map((n) => ({ prompt: `Old question ${n}?`, options: ['w', 'x', 'y', 'z'], correct_index: 0 })) };
const good: QuizGeneration = { ok: true, value: { quiz: QUIZ, topic: 'Cloud' }, attempts: 1, failures: [] };

interface Row {
  id: string;
  source_url: string;
  summary: string;
  quiz: Quiz | null;
  topic: string | null;
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, quiz: Quiz | null = null): Row => ({ id: id(n), source_url: `https://example.test/${n}`, summary: `Summary number ${n}.`, quiz, topic: quiz ? 'Safety' : null });

/** An in-memory store with the same rules as the database one. */
function memory(rows: Row[], hooks: { beforeSet?: (id: string) => void } = {}) {
  const calls = { list: [] as Array<[number, string | undefined]>, set: [] as string[] };
  const store: BackfillStore = {
    async countMissing() {
      return rows.filter((r) => r.quiz === null).length;
    },
    async listMissing(limit, afterId) {
      calls.list.push([limit, afterId]);
      return rows.filter((r) => r.quiz === null && (!afterId || r.id > afterId)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit).map(({ id, source_url, summary }): MissingQuiz => ({ id, source_url, summary }));
    },
    async setQuiz(rowId, quiz, topic) {
      calls.set.push(rowId);
      hooks.beforeSet?.(rowId);
      const r = rows.find((x) => x.id === rowId)!;
      if (r.quiz !== null) return false;
      r.quiz = quiz;
      r.topic = topic;
      return true;
    },
  };
  return { store, rows, calls };
}

function harness(rows: Row[], make: (summary: string) => Promise<QuizGeneration> = async () => good, hooks = {}) {
  const m = memory(rows, hooks);
  const logs: LogEvent[] = [];
  const asked: string[] = [];
  let pauses = 0;
  const run = (extra: Partial<Parameters<typeof runBackfill>[0]> = {}) =>
    runBackfill({ store: m.store, makeQuiz: async (s) => (asked.push(s), make(s)), log: (e) => logs.push(e), pause: async () => void pauses++, ...extra });
  return { ...m, logs, asked, run, pauses: () => pauses };
}

test('Scenario: dry run is the default - it counts, estimates, and changes nothing', async () => {
  const h = harness([row(1), row(2), row(3, OLD_QUIZ), row(4)]);
  const before = JSON.stringify(h.rows);
  const report = await h.run();
  assert.equal(report.mode, 'dry run');
  assert.equal(report.missing, 3);
  assert.equal(report.planned, 3);
  assert.deepEqual(report.estimate, estimateTokens(3));
  assert.equal(report.stored, 0);
  assert.equal(JSON.stringify(h.rows), before); // nothing written
  assert.deepEqual(h.asked, []); // no model call, so no tokens spent
  assert.deepEqual(h.calls.set, []);
  assert.deepEqual(h.calls.list, []); // it did not even read summaries
  assert.equal(h.logs.at(-1)?.event, 'backfill_finished');
});

test('the estimate is articles times the measured cost of an article, with a worst case of 3 attempts each', () => {
  assert.deepEqual(estimateTokens(0), { articles: 0, expectedTokens: 0, worstCaseTokens: 0 });
  assert.deepEqual(estimateTokens(1), { articles: 1, expectedTokens: 5_160, worstCaseTokens: 11_100 });
  assert.deepEqual(estimateTokens(10), { articles: 10, expectedTokens: 51_600, worstCaseTokens: 111_000 });
  assert.deepEqual(estimateTokens(79), { articles: 79, expectedTokens: 407_640, worstCaseTokens: 876_900 }); // what is left on the VM
  assert.equal(EST_TOKENS_PER_ARTICLE, 5_160);
  assert.equal(EST_TOKENS_PER_ATTEMPT, 3_700);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('the dry run plans for the cap, not for everything', async () => {
  const h = harness(Array.from({ length: 40 }, (_, i) => row(i + 1)));
  const report = await h.run({ limit: 12 });
  assert.equal(report.missing, 40);
  assert.equal(report.planned, 12);
  assert.equal(report.estimate.articles, 12);
  assert.equal((await h.run()).planned, DEFAULT_LIMIT);
});

test('Scenario: Backfill - only articles with a null quiz get one, and an existing quiz is never touched', async () => {
  const rows = [row(1), row(2, OLD_QUIZ), row(3), row(4, OLD_QUIZ)];
  const h = harness(rows);
  const report = await h.run({ apply: true });
  assert.equal(report.stored, 2);
  assert.deepEqual(h.asked, ['Summary number 1.', 'Summary number 3.']); // the model was only shown the ones that lack a quiz
  assert.deepEqual(h.calls.set, [id(1), id(3)]);
  assert.deepEqual(rows[1].quiz, OLD_QUIZ);
  assert.deepEqual(rows[3].quiz, OLD_QUIZ);
  assert.equal(rows[1].topic, 'Safety');
  assert.deepEqual(rows[0].quiz, QUIZ);
  assert.equal(rows[0].topic, 'Cloud');
  assert.equal(rows.length, 4); // none deleted
});

test('a quiz that appears between listing and saving is never overwritten', async () => {
  const rows = [row(1), row(2)];
  const h = harness(rows, async () => good, { beforeSet: (rowId: string) => rowId === id(1) && (rows[0].quiz = OLD_QUIZ) });
  const report = await h.run({ apply: true });
  assert.deepEqual(rows[0].quiz, OLD_QUIZ);
  assert.equal(report.alreadyHadQuiz, 1);
  assert.equal(report.stored, 1);
  assert.deepEqual(h.logs.find((l) => l.event === 'backfill_skipped'), { event: 'backfill_skipped', id: id(1), url: 'https://example.test/1', reason: 'already has a quiz' });
});

test('Scenario: the cap per run is respected, in small batches', async () => {
  const h = harness(Array.from({ length: 30 }, (_, i) => row(i + 1)));
  const report = await h.run({ apply: true, limit: 7, batchSize: 3 });
  assert.equal(report.planned, 7);
  assert.equal(report.stored, 7);
  assert.equal(h.asked.length, 7);
  assert.equal(h.rows.filter((r) => r.quiz !== null).length, 7);
  assert.deepEqual(h.calls.list.map(([n]) => n), [3, 3, 1]); // batches of 3, then what is left under the cap
  assert.equal(h.calls.list[0][1], undefined);
  assert.equal(h.calls.list[1][1], id(3)); // each batch starts after the last article of the one before
  assert.equal(h.pauses(), 2); // a pause between batches, not after the last
});

test('the defaults are a cap of 25 and batches of 5', async () => {
  assert.equal(DEFAULT_LIMIT, 25);
  assert.equal(DEFAULT_BATCH_SIZE, 5);
  const h = harness(Array.from({ length: 40 }, (_, i) => row(i + 1)));
  await h.run({ apply: true });
  assert.equal(h.asked.length, 25);
  assert.deepEqual(h.calls.list.map(([n]) => n), [5, 5, 5, 5, 5]);
});

test('Scenario: a failed article keeps a null quiz, its reasons are logged, and the others carry on', async () => {
  const failing: QuizGeneration = { ok: false, reason: 'quiz must have exactly 3 questions', attempts: 3, failures: ['reply contains no JSON object', 'question 1 has no prompt', 'quiz must have exactly 3 questions'] };
  const h = harness([row(1), row(2), row(3)], async (s) => (s.includes('number 2') ? failing : good));
  const report = await h.run({ apply: true });
  assert.equal(report.stored, 2);
  assert.equal(report.failed, 1);
  assert.equal(h.rows[1].quiz, null);
  assert.equal(h.rows[1].topic, null);
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.logs.find((l) => l.event === 'backfill_failed'), { event: 'backfill_failed', id: id(2), url: 'https://example.test/2', attempts: 3, failures: failing.failures });
  assert.deepEqual(h.calls.set, [id(1), id(3)]); // nothing is written for the failed one
});

test('a quiz step that throws is a failure for that article only', async () => {
  const h = harness([row(1), row(2)], async (s) => {
    if (s.includes('number 1')) throw new Error('socket hang up');
    return good;
  });
  const report = await h.run({ apply: true });
  assert.equal(report.failed, 1);
  assert.equal(report.stored, 1);
  assert.deepEqual(h.logs.find((l) => l.event === 'backfill_failed')?.failures, ['quiz step failed: socket hang up']);
});

test('a quiz that needed retries is stored, and the retry reasons are logged', async () => {
  const h = harness([row(1)], async () => ({ ...good, attempts: 2, failures: ['reply contains no JSON object'] }));
  await h.run({ apply: true });
  assert.deepEqual(h.rows[0].quiz, QUIZ);
  assert.deepEqual(h.logs.find((l) => l.event === 'backfill_retried')?.failures, ['reply contains no JSON object']);
});

test('Scenario: safe to run twice - the second run finds nothing to do, calls no model and changes nothing', async () => {
  const rows = [row(1), row(2), row(3, OLD_QUIZ)];
  const h = harness(rows);
  const first = await h.run({ apply: true });
  assert.equal(first.stored, 2);
  const afterFirst = JSON.stringify(rows);
  const callsAfterFirst = h.asked.length;

  const second = await h.run({ apply: true });
  assert.equal(second.missing, 0);
  assert.equal(second.stored, 0);
  assert.equal(second.failed, 0);
  assert.equal(h.asked.length, callsAfterFirst); // no new model call
  assert.equal(JSON.stringify(rows), afterFirst); // identical data
});

test('running twice retries only what failed the first time', async () => {
  let healthy = false;
  const h = harness([row(1), row(2), row(3)], async (s) => (!healthy && s.includes('number 2') ? { ok: false, reason: 'x', attempts: 3, failures: ['x'] } : good));
  await h.run({ apply: true });
  assert.equal(h.rows[1].quiz, null);
  healthy = true;
  h.asked.length = 0;
  const second = await h.run({ apply: true });
  assert.deepEqual(h.asked, ['Summary number 2.']); // only the one that failed
  assert.equal(second.stored, 1);
  assert.deepEqual(h.rows.map((r) => r.quiz !== null), [true, true, true]);
});

test('a failing article is tried once per run, not forever, even when the cap is large', async () => {
  const h = harness([row(1), row(2)], async () => ({ ok: false, reason: 'x', attempts: 3, failures: ['x'] }));
  const report = await h.run({ apply: true, limit: 100, batchSize: 1 });
  assert.equal(h.asked.length, 2);
  assert.equal(report.failed, 2);
});

test('with the real quiz generator, and a model that answers properly, every article ends with a valid quiz and topic', async () => {
  const chat: Chat = async () => JSON.stringify({ questions: QUIZ.questions, topic: 'agents' });
  const h = harness([row(1), row(2)], (s) => generateQuiz(s, chat, { verify: false }));
  await h.run({ apply: true });
  assert.deepEqual(h.rows.map((r) => r.topic), ['Agents', 'Agents']);
  assert.deepEqual(h.rows[0].quiz, QUIZ);
});

test('bad limits and batch sizes are refused before anything happens', async () => {
  const h = harness([row(1)]);
  for (const limit of [0, -1, 1.5, Number.NaN]) await assert.rejects(h.run({ apply: true, limit }), /limit must be a whole number/);
  for (const batchSize of [0, -3, 2.5]) await assert.rejects(h.run({ apply: true, batchSize }), /batch size must be a whole number/);
  assert.deepEqual(h.asked, []);
});

test('Scenario: the command line - a dry run unless --apply is given, and a typo never starts a real run', () => {
  assert.deepEqual(parseArgs([]), { apply: false, limit: 25, batchSize: 5 });
  assert.deepEqual(parseArgs(['--apply', '--limit', '10', '--batch-size', '2']), { apply: true, limit: 10, batchSize: 2 });
  assert.deepEqual(parseArgs(['--limit', '3']), { apply: false, limit: 3, batchSize: 5 });
  for (const bad of [['--aply'], ['apply'], ['--limit'], ['--limit', '0'], ['--limit', 'ten'], ['--limit', '5.5'], ['--batch-size', '-1'], ['--apply', '--force']]) {
    assert.throws(() => parseArgs(bad), /unknown option|needs a whole number/, bad.join(' '));
  }
});

test('the script and its store can only read and update: no DELETE, TRUNCATE or DROP', () => {
  for (const file of ['./backfillQuiz.ts', './db.ts']) {
    const code = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\b(DELETE|TRUNCATE|DROP)\b/i, file);
  }
  const store = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(store, /UPDATE articles SET quiz = \$2::jsonb, topic = \$3 WHERE id = \$1 AND quiz IS NULL/);
});
