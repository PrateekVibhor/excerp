// The pipeline's own record of when it ran, against the real SQL in a throwaway schema. Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createArticleStore } from './db.ts';
import { createRunLog, type RunLog } from './runLog.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `runlog_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let log: RunLog;
let skip: string | false = false;

before(async () => {
  const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch {
    skip = 'no database reachable';
    await admin.end();
    return;
  }
  await admin.end();
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  log = createRunLog(pool);
});
after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const at = (iso: string) => new Date(iso);
const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await pool!.query('TRUNCATE pipeline_runs, verifications, articles CASCADE');
    await fn();
  });
const words = Array.from({ length: 55 }, (_, i) => `w${i}`).join(' ');
const addArticle = (n: number, fetchedAt: string) =>
  createArticleStore(pool!).insert({ source_company: 'Google', source_url: `https://blog.google/runlog-${n}`, content_type: 'Release', title: `Post ${n}`, summary: words, published_at: '2026-09-01T00:00:00.000Z', fetched_at: fetchedAt, reader_count: 0 });

t('with no runs and no articles there is no last run', async () => {
  assert.equal(await log.lastSuccessAt(), undefined);
});

t('a successful run is the last run, at the time it started', async () => {
  await log.record({ startedAt: at('2026-10-09T01:00:00Z'), finishedAt: at('2026-10-09T01:20:00Z'), outcome: 'ok', stored: 5 });
  assert.equal((await log.lastSuccessAt())?.toISOString(), '2026-10-09T01:00:00.000Z');
});

t('the latest successful run wins, whatever order they were written in', async () => {
  await log.record({ startedAt: at('2026-10-09T01:00:00Z'), finishedAt: at('2026-10-09T01:10:00Z'), outcome: 'ok', stored: 1 });
  await log.record({ startedAt: at('2026-10-07T01:00:00Z'), finishedAt: at('2026-10-07T01:10:00Z'), outcome: 'ok', stored: 1 });
  assert.equal((await log.lastSuccessAt())?.toISOString(), '2026-10-09T01:00:00.000Z');
});

t('Scenario: a failed run does not count, so the next start catches up again', async () => {
  await log.record({ startedAt: at('2026-10-05T01:00:00Z'), finishedAt: at('2026-10-05T01:10:00Z'), outcome: 'ok', stored: 3 });
  await log.record({ startedAt: at('2026-10-08T01:00:00Z'), finishedAt: at('2026-10-08T01:00:05Z'), outcome: 'failed', error: 'search service down' });
  assert.equal((await log.lastSuccessAt())?.toISOString(), '2026-10-05T01:00:00.000Z');
});

t('only failed runs means there is no last success', async () => {
  await log.record({ startedAt: at('2026-10-08T01:00:00Z'), finishedAt: at('2026-10-08T01:00:05Z'), outcome: 'failed', error: 'x' });
  assert.equal(await log.lastSuccessAt(), undefined);
});

t('Scenario: the first start after this change, with no runs recorded yet, uses when articles were last fetched', async () => {
  await addArticle(1, '2026-10-05T23:22:06Z');
  await addArticle(2, '2026-10-03T08:00:00Z');
  assert.equal((await log.lastSuccessAt())?.toISOString(), '2026-10-05T23:22:06.000Z');
});

t('once a run is recorded, it is used and the articles are no longer consulted', async () => {
  await addArticle(1, '2026-10-05T23:22:06Z');
  await log.record({ startedAt: at('2026-10-02T00:00:00Z'), finishedAt: at('2026-10-02T00:10:00Z'), outcome: 'ok', stored: 1 });
  assert.equal((await log.lastSuccessAt())?.toISOString(), '2026-10-02T00:00:00.000Z');
});

t('the record keeps what happened: how many articles, and the reason for a failure', async () => {
  await log.record({ startedAt: at('2026-10-09T01:00:00Z'), finishedAt: at('2026-10-09T01:20:00Z'), outcome: 'ok', stored: 12 });
  await log.record({ startedAt: at('2026-10-09T02:00:00Z'), finishedAt: at('2026-10-09T02:00:03Z'), outcome: 'failed', error: 'model unreachable' });
  const { rows } = await pool!.query('SELECT outcome, stored, error FROM pipeline_runs ORDER BY started_at');
  assert.deepEqual(rows, [{ outcome: 'ok', stored: 12, error: null }, { outcome: 'failed', stored: null, error: 'model unreachable' }]);
});

t('the table refuses a run that makes no sense: another outcome, a negative count, or a finish before the start', async () => {
  const bad = (sql: string) => assert.rejects(pool!.query(sql));
  await bad(`INSERT INTO pipeline_runs (started_at, finished_at, outcome) VALUES (now(), now(), 'maybe')`);
  await bad(`INSERT INTO pipeline_runs (started_at, finished_at, outcome, stored) VALUES (now(), now(), 'ok', -1)`);
  await bad(`INSERT INTO pipeline_runs (started_at, finished_at, outcome) VALUES (now(), now() - interval '1 minute', 'ok')`);
});
