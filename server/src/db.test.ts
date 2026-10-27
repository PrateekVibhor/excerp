// Runs the real SQL against PostgreSQL, in a throwaway schema that is dropped afterwards.
// Skipped when no database is reachable (for example without DATABASE_URL).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { CONTENT_TYPES, SOURCE_COMPANIES } from '../../src/data/types.ts';
import { createArticleReader, createArticleStore, createBackfillStore, type NewArticle } from './db.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `test_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
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
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const article = (n: number): NewArticle => ({
  source_company: 'Google',
  source_url: `https://blog.google/innovation-and-ai/post-${n}`,
  content_type: 'Release',
  title: `Post ${n}`,
  summary: words(55),
  // Published out of order on purpose: every 7th day, wrapping around.
  published_at: new Date(Date.UTC(2026, 0, 1) + ((n * 7) % 50) * 86_400_000).toISOString(),
  fetched_at: '2026-10-04T12:00:00.000Z',
  reader_count: n,
});

test('Scenario: Feed ordering and limit - 50 stored, limit 10 returns exactly 10, newest published first', async (t) => {
  if (skip) return t.skip(skip);
  const store = createArticleStore(pool!);
  for (let n = 1; n <= 50; n++) assert.equal(await store.insert(article(n)), true);

  const feed = await createArticleReader(pool!).feed(10);
  assert.equal(feed.length, 10);
  const all = Array.from({ length: 50 }, (_, i) => article(i + 1)).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  assert.deepEqual(feed.map((a) => a.source_url), all.slice(0, 10).map((a) => a.source_url));
  for (let i = 1; i < feed.length; i++) assert.ok(feed[i - 1].published_at >= feed[i].published_at);
});

test('rows come back in the Article shape with ISO dates', async (t) => {
  if (skip) return t.skip(skip);
  const [a] = await createArticleReader(pool!).feed(1);
  assert.deepEqual(Object.keys(a).sort(), [
    'content_type', 'fetched_at', 'id', 'published_at', 'quiz', 'reader_count', 'source_company', 'source_url', 'summary', 'title', 'topic',
  ]);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.match(a.published_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof a.reader_count, 'number');
});

test('getById finds a stored article; unknown and malformed ids give undefined', async (t) => {
  if (skip) return t.skip(skip);
  const reader = createArticleReader(pool!);
  const [first] = await reader.feed(1);
  assert.deepEqual(await reader.getById(first.id), first);
  assert.equal(await reader.getById('00000000-0000-4000-8000-000000000000'), undefined);
  assert.equal(await reader.getById('not-a-uuid'), undefined);
  assert.equal(await reader.getById("1' OR '1'='1"), undefined);
});

test('the store refuses a second copy of the same URL', async (t) => {
  if (skip) return t.skip(skip);
  const store = createArticleStore(pool!);
  assert.equal(await store.insert(article(1)), false);
  assert.deepEqual(await store.existingUrls([article(1).source_url, 'https://example.test/new']), new Set([article(1).source_url]));
});

// ---- Business and Finance -------------------------------------------------------------------------

const sqlList = (sql: string, column: string) => {
  const match = sql.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
  assert.ok(match, `no rule for ${column}`);
  return [...match![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
};

test('the allowed values in schema.sql and in the migration are exactly the lists the code uses', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/001_business_and_finance.sql', import.meta.url), 'utf8');
  for (const sql of [schemaSql, migration]) {
    assert.deepEqual(sqlList(sql, 'source_company'), [...SOURCE_COMPANIES]);
    assert.deepEqual(sqlList(sql, 'content_type'), [...CONTENT_TYPES]);
  }
});

test('Scenario: Business and Finance - every publisher and every tag can be stored', async (t) => {
  if (skip) return t.skip(skip);
  const store = createArticleStore(pool!);
  for (const [i, company] of SOURCE_COMPANIES.entries()) {
    const type = CONTENT_TYPES[i % CONTENT_TYPES.length];
    const inserted = await store.insert({ ...article(1000 + i), source_company: company, content_type: type });
    assert.equal(inserted, true, `${company} / ${type}`);
  }
  for (const [i, type] of CONTENT_TYPES.entries()) {
    assert.equal(await store.insert({ ...article(2000 + i), content_type: type }), true, type);
  }
});

test('the rules still refuse a publisher or tag that is not in the lists', async (t) => {
  if (skip) return t.skip(skip);
  const store = createArticleStore(pool!);
  await assert.rejects(store.insert({ ...article(3001), source_company: 'Bloomberg' as never }), /articles_source_company_check/);
  await assert.rejects(store.insert({ ...article(3002), source_company: 'mckinsey' as never }), /articles_source_company_check/);
  await assert.rejects(store.insert({ ...article(3003), content_type: 'Podcast' as never }), /articles_content_type_check/);
  await assert.rejects(store.insert({ ...article(3004), content_type: 'consulting' as never }), /articles_content_type_check/);
});

// The articles table as it was before Business and Finance, with its old rules (and the Feature 8
// columns, which the store always writes; migration 002 has its own test below).
const OLD_TABLE = `
  CREATE TABLE articles (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_company text        NOT NULL CHECK (source_company IN ('NVIDIA', 'Google', 'Meta', 'OpenAI', 'Anthropic', 'AWS', 'Microsoft')),
    source_url     text        NOT NULL UNIQUE,
    content_type   text        NOT NULL CHECK (content_type IN ('Research Paper', 'White Paper', 'Tech Blog', 'Release')),
    title          text        NOT NULL CHECK (length(trim(title)) > 0),
    summary        text        NOT NULL CHECK (array_length(regexp_split_to_array(trim(summary), '\\s+'), 1) BETWEEN 50 AND 60),
    published_at   timestamptz NOT NULL,
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    reader_count   integer     NOT NULL DEFAULT 0 CHECK (reader_count >= 0),
    quiz           jsonb,
    topic          text
  );`;

test('Scenario: Migration - an existing database with articles in it accepts the new values, and keeps every article', async (t) => {
  if (skip) return t.skip(skip);
  const old = `${schema}_old`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${old}`);
  const oldPool = new pg.Pool({ connectionString: url, options: `-c search_path=${old}` });
  try {
    await oldPool.query(OLD_TABLE);
    const oldStore = createArticleStore(oldPool);
    for (let n = 1; n <= 5; n++) await oldStore.insert(article(n));
    // before: the old database refuses a business publisher and a business tag
    await assert.rejects(oldStore.insert({ ...article(10), source_company: 'McKinsey' as never, content_type: 'Consulting' as never }), /check constraint/);

    const migration = readFileSync(new URL('../migrations/001_business_and_finance.sql', import.meta.url), 'utf8');
    await oldPool.query(migration);

    // after: accepted, the five articles are still there and unchanged, and unknown values are still refused
    assert.equal(await oldStore.insert({ ...article(10), source_company: 'McKinsey' as never, content_type: 'Consulting' as never }), true);
    assert.equal(await oldStore.insert({ ...article(11), source_company: 'Y Combinator' as never, content_type: 'Venture Capital' as never }), true);
    const { rows } = await oldPool.query('SELECT source_url, source_company, content_type, reader_count FROM articles ORDER BY source_url');
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.filter((r) => r.source_company === 'Google').map((r) => r.content_type), ['Release', 'Release', 'Release', 'Release', 'Release']);
    await assert.rejects(oldStore.insert({ ...article(12), source_company: 'Bloomberg' as never }), /articles_source_company_check/);
    await assert.rejects(oldStore.insert({ ...article(13), content_type: 'Podcast' as never }), /articles_content_type_check/);

    // running it a second time changes nothing and does not fail
    await oldPool.query(migration);
    assert.equal((await oldPool.query('SELECT count(*)::int AS n FROM articles')).rows[0].n, 7);
    const names = (await oldPool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'articles'::regclass AND contype = 'c' ORDER BY 1`)).rows.map((r) => r.conname);
    assert.deepEqual(names, ['articles_content_type_check', 'articles_reader_count_check', 'articles_source_company_check', 'articles_summary_check', 'articles_title_check']);
  } finally {
    await oldPool.end();
    await admin.query(`DROP SCHEMA ${old} CASCADE`);
    await admin.end();
  }
});


test('Scenario: Migration 002 - adds the optional quiz and topic columns, keeps every article, and can run twice', async (t) => {
  if (skip) return t.skip(skip);
  const old = `${schema}_old2`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${old}`);
  const oldPool = new pg.Pool({ connectionString: url, options: `-c search_path=${old}` });
  const columns = async () => (await oldPool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'articles' AND column_name IN ('quiz', 'topic') ORDER BY 1`, [old])).rows;
  try {
    await oldPool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/,\s*quiz\s+jsonb,.*?\n\s*topic\s+text[^\n]*\n/s, '\n'));
    assert.deepEqual(await columns(), []); // the old table has neither column
    const store = createArticleStore(oldPool);
    for (let n = 1; n <= 3; n++) {
      const a = article(n); // the old table has no quiz columns, so the store cannot be used yet
      await oldPool.query('INSERT INTO articles (source_company, source_url, content_type, title, summary, published_at, fetched_at, reader_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [a.source_company, a.source_url, a.content_type, a.title, a.summary, a.published_at, a.fetched_at, a.reader_count]);
    }

    const migration = readFileSync(new URL('../migrations/002_quiz_topic.sql', import.meta.url), 'utf8');
    await oldPool.query(migration);
    await oldPool.query(migration); // a second run changes nothing and does not fail

    assert.deepEqual(await columns(), [
      { column_name: 'quiz', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'topic', data_type: 'text', is_nullable: 'YES' },
    ]);
    const { rows } = await oldPool.query('SELECT source_url, quiz, topic FROM articles ORDER BY source_url');
    assert.equal(rows.length, 3); // no article lost
    assert.ok(rows.every((r) => r.quiz === null && r.topic === null));
    assert.equal(await store.insert(article(4)), true); // new articles still go in without a quiz
  } finally {
    await oldPool.end();
    await admin.query(`DROP SCHEMA ${old} CASCADE`);
    await admin.end();
  }
});

test('schema.sql has the quiz and topic columns that the migration adds', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schemaSql, /quiz\s+jsonb/);
  assert.match(schemaSql, /topic\s+text/);
});

test('Scenario: quiz and topic are stored with the article and read back unchanged; without them both are null', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const store = createArticleStore(db);
  const quiz = { questions: [0, 1, 2].map((n) => ({ prompt: `Q${n} with "quotes" and ünïcode?`, options: ['a', 'b', 'c', 'd'].map((o) => `${o}${n}`), correct_index: n })) };
  assert.equal(await store.insert({ ...article(5001), quiz, topic: 'Agents' }), true);
  assert.equal(await store.insert({ ...article(5002), quiz: null, topic: null }), true);
  assert.equal(await store.insert(article(5003)), true); // fields left out
  const read = async (n: number) => (await db.query('SELECT quiz, topic FROM articles WHERE source_url = $1', [article(n).source_url])).rows[0];
  assert.deepEqual(await read(5001), { quiz, topic: 'Agents' });
  assert.deepEqual(await read(5002), { quiz: null, topic: null });
  assert.deepEqual(await read(5003), { quiz: null, topic: null });
});

test('Scenario: the reader returns quiz and topic in /feed and by id, null when an article has none', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const store = createArticleStore(db);
  const quiz = { questions: [0, 1, 2].map((n) => ({ prompt: `Q${n}?`, options: ['a', 'b', 'c', 'd'].map((o) => `${o}${n}`), correct_index: 3 - n })) };
  // newest of all, so they come first in the feed
  await store.insert({ ...article(6001), published_at: '2099-01-02T00:00:00.000Z', quiz, topic: 'Safety' });
  await store.insert({ ...article(6002), published_at: '2099-01-01T00:00:00.000Z' });
  const reader = createArticleReader(db);
  const [withQuiz, without] = await reader.feed(2);
  assert.equal(withQuiz.source_url, article(6001).source_url);
  assert.deepEqual(withQuiz.quiz, quiz); // jsonb comes back as an object, in order
  assert.equal(withQuiz.topic, 'Safety');
  assert.strictEqual(without.quiz, null);
  assert.strictEqual(without.topic, null);
  const byId = await reader.getById(withQuiz.id);
  assert.deepEqual(byId?.quiz, quiz);
  assert.equal(byId?.topic, 'Safety');
  assert.strictEqual((await reader.getById(without.id))?.quiz, null);
  // rows stored before the quiz existed (null columns) read the same way
  assert.deepEqual(Object.keys(without).sort(), ['content_type', 'fetched_at', 'id', 'published_at', 'quiz', 'reader_count', 'source_company', 'source_url', 'summary', 'title', 'topic']);
});

test('Scenario: backfill store - lists only articles without a quiz in id order, and never overwrites a quiz', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  await db.query('DELETE FROM articles'); // this test's schema is private to the test file
  const store = createArticleStore(db);
  const old = { questions: [0, 1, 2].map((n) => ({ prompt: `Old ${n}?`, options: ['a', 'b', 'c', 'd'], correct_index: 1 })) };
  const fresh = { questions: [0, 1, 2].map((n) => ({ prompt: `New ${n}?`, options: ['p', 'q', 'r', 's'], correct_index: 2 })) };
  for (let n = 7001; n <= 7005; n++) await store.insert({ ...article(n), quiz: n === 7002 ? old : null, topic: n === 7002 ? 'Safety' : null });
  const backfill = createBackfillStore(db);
  assert.equal(await backfill.countMissing(), 4);
  const first = await backfill.listMissing(3);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((r) => r.id), [...first.map((r) => r.id)].sort()); // id order
  assert.ok(!first.some((r) => r.source_url === article(7002).source_url)); // the one with a quiz is never listed
  assert.deepEqual(Object.keys(first[0]).sort(), ['id', 'source_url', 'summary']);
  const rest = await backfill.listMissing(3, first[2].id);
  assert.equal(rest.length, 1);
  assert.ok(rest[0].id > first[2].id);

  assert.equal(await backfill.setQuiz(first[0].id, fresh, 'Cloud'), true);
  assert.equal(await backfill.setQuiz(first[0].id, old, 'Agents'), false); // second write is refused
  const [hasQuiz] = (await db.query('SELECT quiz, topic FROM articles WHERE id = $1', [first[0].id])).rows;
  assert.deepEqual(hasQuiz, { quiz: fresh, topic: 'Cloud' });
  const existing = (await db.query('SELECT id FROM articles WHERE source_url = $1', [article(7002).source_url])).rows[0].id;
  assert.equal(await backfill.setQuiz(existing, fresh, 'Cloud'), false); // an old quiz is never replaced
  assert.deepEqual((await db.query('SELECT quiz, topic FROM articles WHERE id = $1', [existing])).rows[0], { quiz: old, topic: 'Safety' });
  assert.equal(await backfill.countMissing(), 3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM articles')).rows[0].n, 5); // nothing deleted
});

// ---- Feature 9: players and verifications -----------------------------------------------------------

const DEVICE = '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90';
const DEVICE_2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const articleIdOf = async (n: number) => (await pool!.query('SELECT id FROM articles WHERE source_url = $1', [article(n).source_url])).rows[0].id as string;

/** schema.sql as it was before Feature 9: everything up to the leaderboard section. */
const schemaBeforeLeaderboard = () => readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').split('-- Feature 9')[0];

test('Scenario: Migration 003 - adds the two tables, keeps every article, and can run twice', async (t) => {
  if (skip) return t.skip(skip);
  const old = `${schema}_old3`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${old}`);
  const oldPool = new pg.Pool({ connectionString: url, options: `-c search_path=${old}` });
  const tables = async () => (await oldPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('players', 'verifications') ORDER BY 1`, [old])).rows.map((r) => r.table_name);
  try {
    await oldPool.query(schemaBeforeLeaderboard());
    assert.deepEqual(await tables(), []); // the old database has neither table
    const store = createArticleStore(oldPool);
    for (let n = 1; n <= 3; n++) assert.equal(await store.insert(article(n)), true);

    const migration = readFileSync(new URL('../migrations/003_leaderboard.sql', import.meta.url), 'utf8');
    await oldPool.query(migration);
    await oldPool.query(migration); // a second run changes nothing and does not fail

    assert.deepEqual(await tables(), ['players', 'verifications']);
    assert.equal((await oldPool.query('SELECT count(*)::int AS n FROM articles')).rows[0].n, 3); // no article lost
    assert.equal(await store.insert(article(4)), true);
  } finally {
    await oldPool.end();
    await admin.query(`DROP SCHEMA ${old} CASCADE`);
    await admin.end();
  }
});

test('a database made from schema.sql and one brought up by the migration end up with the same tables', async (t) => {
  if (skip) return t.skip(skip);
  const migrated = `${schema}_same3`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${migrated}`);
  const migratedPool = new pg.Pool({ connectionString: url, options: `-c search_path=${migrated}` });
  const describe = async (p: pg.Pool, name: string) => ({
    columns: (await p.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('players', 'verifications') ORDER BY 1, ordinal_position`, [name])).rows,
    constraints: (await p.query(`SELECT conrelid::regclass::text AS tbl, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = $1::regnamespace AND conrelid::regclass::text IN ('players', 'verifications') ORDER BY 1, 2, 3`, [name])).rows,
  });
  try {
    await migratedPool.query(schemaBeforeLeaderboard());
    await migratedPool.query(readFileSync(new URL('../migrations/003_leaderboard.sql', import.meta.url), 'utf8'));
    const fresh = await describe(pool!, schema);
    const upgraded = await describe(migratedPool, migrated);
    assert.ok(fresh.columns.length === 6 && fresh.constraints.length >= 5, 'the tables exist with their columns and rules');
    assert.deepEqual(upgraded, fresh);
  } finally {
    await migratedPool.end();
    await admin.query(`DROP SCHEMA ${migrated} CASCADE`);
    await admin.end();
  }
});

test('a player and a verification can be stored, and a verification sent twice is stored once', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  await createArticleStore(db).insert(article(8001));
  const id = await articleIdOf(8001);
  await db.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, 'Maya Chen', now())`, [DEVICE]);
  const send = () => db.query(`INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, now()) ON CONFLICT (device_id, article_id) DO NOTHING`, [DEVICE, id]);
  assert.equal((await send()).rowCount, 1);
  assert.equal((await send()).rowCount, 0); // the second is ignored
  assert.equal((await db.query('SELECT count(*)::int AS n FROM verifications WHERE device_id = $1', [DEVICE])).rows[0].n, 1);
  // the same article for another device is a separate verification
  await db.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, 'Daniel', now())`, [DEVICE_2]);
  await db.query(`INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, now())`, [DEVICE_2, id]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM verifications WHERE article_id = $1', [id])).rows[0].n, 2);
});

test('a plain duplicate insert is refused, so the pair really is unique', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const id = await articleIdOf(8001);
  await assert.rejects(db.query(`INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, now())`, [DEVICE, id]), /verifications_pkey/);
});

test('Scenario: Bad device id - only a lower-case UUID is accepted', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const add = (device: string) => db.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, 'X', now())`, [device]);
  for (const bad of ['', 'not-a-uuid', DEVICE.toUpperCase(), ` ${DEVICE}`, `${DEVICE}0`, DEVICE.replace(/-/g, ''), 'mock-1']) {
    await assert.rejects(add(bad), /players_device_id_check/, JSON.stringify(bad));
  }
  assert.equal((await add('11111111-2222-3333-4444-555555555555')).rowCount, 1);
});

test('Scenario: Bad name - 1 to 40 characters, already trimmed', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const add = (n: number, name: string) => db.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, $2, now())`, [`aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`, name]);
  for (const [n, bad] of [[1, ''], [2, '   '], [3, 'x'.repeat(41)], [4, ' padded'], [5, 'padded ']] as const) {
    await assert.rejects(add(n, bad), /players_display_name_check/, JSON.stringify(bad));
  }
  assert.equal((await add(6, 'x')).rowCount, 1);
  assert.equal((await add(7, 'x'.repeat(40))).rowCount, 1);
  assert.equal((await add(8, 'Zoë Ünal 🙂')).rowCount, 1); // names are not limited to ASCII
  await assert.rejects(db.query(`INSERT INTO players (device_id, display_name, updated_at) VALUES ($1, NULL, now())`, ['aaaaaaaa-bbbb-cccc-dddd-000000000009']), /null value/);
  await assert.rejects(add(6, 'Same device twice'), /players_pkey/);
});

test('Scenario: Unknown article or player - a verification must point at a real article and a known player', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const id = await articleIdOf(8001);
  const verify = (device: string, article: string) => db.query(`INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, now())`, [device, article]);
  await assert.rejects(verify(DEVICE, '00000000-0000-4000-8000-000000000000'), /verifications_article_id_fkey/); // no such article
  await assert.rejects(verify(DEVICE, 'mock-1'), /invalid input syntax for type uuid/); // the app's mock ids are not article ids
  await assert.rejects(verify('99999999-9999-4999-9999-999999999999', id), /verifications_device_id_fkey/); // never introduced itself
  await assert.rejects(db.query(`INSERT INTO verifications (device_id, article_id, verified_at) VALUES ($1, $2, NULL)`, [DEVICE_2, id]), /null value/);
});

test('an article that has verifications cannot be deleted by accident', async (t) => {
  if (skip) return t.skip(skip);
  const db = pool!;
  const id = await articleIdOf(8001);
  await assert.rejects(db.query('DELETE FROM articles WHERE id = $1', [id]), /verifications_article_id_fkey/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM articles WHERE id = $1', [id])).rows[0].n, 1);
});

test('schema.sql and the migration both carry the same leaderboard section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/003_leaderboard.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Feature 9'), schemaSql.indexOf('-- Feature 11')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly the tables that schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i); // it only adds
});

test('schema.sql and the migration both carry the same sign-in section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/004_auth.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Feature 11'), schemaSql.indexOf('-- Pipeline catch-up')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly the tables that schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i); // it only adds
});

test('schema.sql and the migration both carry the same pipeline-runs section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/005_pipeline_runs.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Pipeline catch-up'), schemaSql.indexOf('-- Plan 14')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly the table that schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i); // it only adds
});

test('schema.sql and the migration both carry the same accounts section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/006_accounts.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 14'), schemaSql.indexOf('-- Plan 15')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly the tables that schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE)\b/im); // it only adds (one nullable column, with ADD COLUMN IF NOT EXISTS); 'ON DELETE CASCADE' is a rule, not a statement
  assert.deepEqual(migration.match(/\bALTER TABLE \w+ \w+ \w+ \w+ \w+ \w+/g), ['ALTER TABLE sessions ADD COLUMN IF NOT EXISTS']);
});

test('schema.sql and the migration both carry the same readers section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/007_readers.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 15: readers'), schemaSql.indexOf('-- Plan 15, part 2')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im); // it only adds
  // Every change to an existing table is an ADD COLUMN IF NOT EXISTS, and every reader starts hidden.
  assert.doesNotMatch(migration.replace(/ADD COLUMN IF NOT EXISTS/g, ''), /ALTER TABLE accounts\s+(?!\s*$)\S*\s*[A-Z]*\s*(DROP|ALTER|RENAME)/i);
  assert.match(migration, /discoverable\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(migration, /accepts_messages\s+boolean\s+NOT NULL DEFAULT false/);
});

test('schema.sql and the migration both carry the same messages section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/008_messages.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 15, part 2'), schemaSql.indexOf('-- Plan 16')).trim();
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im); // it only adds
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_at']);
});


test('schema.sql and the migration both carry the same courses section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/009_courses.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16:'), schemaSql.indexOf('-- Plan 16, part 2')).trim();
  assert.ok(section.length > 1000, 'schema.sql has a Plan 16 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im); // it only adds
  // The one change to a table after it is made: the version table's link back to courses, added once courses exists.
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD CONSTRAINT \w+/g), ['ALTER TABLE course_versions ADD CONSTRAINT course_versions_course_fk']);
  assert.doesNotMatch(migration, /ALTER TABLE (accounts|articles|sessions|conversations|messages)\b/); // nothing existing is changed
  // The inactive observation tables and the old name are not created.
  for (const name of ['role_snapshots', 'snapshot_skills', 'skill_series', 'role_terms', 'posting_sources']) assert.doesNotMatch(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`));
  // Twenty-nine tables.
  assert.equal(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g)?.length, 29);
});


test('schema.sql and the migration both carry the same scenario-concepts section', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/010_course_scenarios.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 2'), schemaSql.indexOf('-- Plan 16, part 3')).trim();
  assert.ok(section.length > 100, 'schema.sql has a Plan 16 part 2 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im); // it only adds
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE role_concepts ADD COLUMN IF NOT EXISTS kind']);
});

test('schema.sql and the migration both carry the same industry section, and the migration only adds columns and replaces the two course indexes', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/011_course_industry.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 3'), schemaSql.indexOf('-- Plan 16, part 4')).trim();
  assert.ok(section.length > 300, 'schema.sql has a Plan 16 part 3 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE)\b/im);
  assert.deepEqual(migration.match(/^DROP INDEX IF EXISTS \w+/gm), ['DROP INDEX IF EXISTS courses_shared_role_key', 'DROP INDEX IF EXISTS courses_private_role_key']); // the only things it removes
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), [
    'ALTER TABLE courses ADD COLUMN IF NOT EXISTS industry',
    'ALTER TABLE concept_claims ADD COLUMN IF NOT EXISTS industry',
    'ALTER TABLE resources ADD COLUMN IF NOT EXISTS industry',
  ]);
});

test('schema.sql and the migration both carry the same library section, and the migration only adds', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/012_library_use.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 4'), schemaSql.indexOf('-- Plan 16, part 5')).trim();
  assert.ok(section.length > 300, 'schema.sql has a Plan 16 part 4 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im); // it only adds
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE concept_claims ADD COLUMN IF NOT EXISTS library_source_id']);
  assert.deepEqual(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g), ['CREATE TABLE IF NOT EXISTS library_use']);
});


test('schema.sql and migration 013 carry the same library-in-the-database section, and the migration only adds tables', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/013_library_db.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 5'), schemaSql.indexOf('-- Plan 16, part 6')).trim();
  assert.ok(section.length > 1500, 'schema.sql has a Plan 16 part 5 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE|ALTER)\b/im);
  assert.deepEqual(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g)?.map((x) => x.split(' ').pop()), ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage']);
});

test('schema.sql and migration 014 carry the same gap-queue section, and the migration only adds tables', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/014_library_gaps.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 6'), schemaSql.indexOf('-- Plan 16, part 7')).trim();
  assert.ok(section.length > 800, 'schema.sql has a Plan 16 part 6 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE|ALTER)\b/im);
  assert.deepEqual(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g)?.map((x) => x.split(' ').pop()), ['library_gaps', 'library_candidates']);
});

test('schema.sql and migration 015 carry the same list-mode section; the migration adds a defaulted column and tables, and replaces only the two role indexes', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/015_list_mode.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 7'), schemaSql.indexOf('-- Plan 16, part 8')).trim();
  assert.ok(section.length > 1500, 'schema.sql has a Plan 16 part 7 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE)\b/im);
  assert.deepEqual(migration.match(/^DROP INDEX IF EXISTS \w+/gm), ['DROP INDEX IF EXISTS courses_shared_role_industry_key', 'DROP INDEX IF EXISTS courses_private_role_industry_key']);
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+ [^;]*/g), ["ALTER TABLE courses ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'narrow' CHECK (mode IN ('narrow', 'list'))"]);
  assert.deepEqual(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g)?.map((x) => x.split(' ').pop()), ['list_concepts', 'list_links']);
});

test('schema.sql and migration 016 carry the same notification section: one new change kind and one unique index, and nothing is deleted', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/016_list_notifications.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 8'), schemaSql.indexOf('-- Plan 16, part 9')).trim();
  assert.ok(section.length > 500, 'schema.sql has a Plan 16 part 8 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE|CREATE TABLE)\b/im);
  assert.match(migration, /'postings_updated', 'coverage_improved'\)/);
  assert.deepEqual(migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS \w+/g), ['CREATE UNIQUE INDEX IF NOT EXISTS course_changes_coverage_key']);
});

test('schema.sql and migration 017 carry the same pasted-description section: one nullable, length-limited column on course_inputs, and nothing else', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/017_pasted_description.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 9'), schemaSql.indexOf('-- Plan 16, part 10')).trim();
  assert.ok(section.length > 200, 'schema.sql has a Plan 16 part 9 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE|CREATE)\b/im);
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE course_inputs ADD COLUMN IF NOT EXISTS pasted_text']);
});

test('schema.sql and migration 018 carry the same section: two nullable-or-defaulted columns on course_concepts for the tools a posting named and the skill category, and nothing else', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/018_concept_tools.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 10'), schemaSql.indexOf('-- Plan 16, part 11')).trim();
  assert.ok(section.length > 200, 'schema.sql has a Plan 16 part 10 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE|CREATE)\b/im);
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS tools', 'ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS skill_category']);
});

test('schema.sql and migration 019 carry the same section: one defaulted column on skill_taxonomies for the terms a taxonomy leaves unplaced, and nothing else', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/019_taxonomy_unplaced.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 11'), schemaSql.indexOf('-- Plan 16, part 12')).trim();
  assert.ok(section.length > 150, 'schema.sql has a Plan 16 part 11 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|TRUNCATE|UPDATE|CREATE)\b/im);
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE skill_taxonomies ADD COLUMN IF NOT EXISTS unplaced']);
});

test('schema.sql and migration 020 carry the same section: a reader\'s lists are independent (a flag on the course, a course for each private concept, a title for each reader\'s entry) and the two unique rules are narrowed to match, and nothing is deleted', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/020_independent_lists.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 12'), schemaSql.indexOf('-- Plan 16, part 13')).trim();
  assert.ok(section.length > 400, 'schema.sql has a Plan 16 part 12 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE)\b/im);
  assert.deepEqual(migration.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+/g), ['ALTER TABLE courses ADD COLUMN IF NOT EXISTS independent', 'ALTER TABLE role_concepts ADD COLUMN IF NOT EXISTS course_id', 'ALTER TABLE course_inputs ADD COLUMN IF NOT EXISTS title']);
  assert.deepEqual(migration.match(/^DROP INDEX IF EXISTS \w+/gm), ['DROP INDEX IF EXISTS courses_private_role_industry_key', 'DROP INDEX IF EXISTS role_concepts_private_name_key'], 'only the two rules that are narrowed are dropped');
});

test('schema.sql and migration 021 carry the same section: one new table for remembered page judgments, and nothing existing is changed', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/021_link_judgments.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Plan 16, part 13'), schemaSql.indexOf('-- Sign in with Apple')).trim();
  assert.ok(section.length > 300, 'schema.sql has a Plan 16 part 13 section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(ALTER|DROP|DELETE|TRUNCATE|UPDATE)\b/im);
  assert.deepEqual(migration.match(/CREATE TABLE IF NOT EXISTS \w+/g), ['CREATE TABLE IF NOT EXISTS link_judgments']);
});


test('schema.sql and migration 022 carry the same Sign in with Apple section: google_sub optional, apple_sub added and unique, at least one of the two required, and nothing else', () => {
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/022_apple_sign_in.sql', import.meta.url), 'utf8');
  const section = schemaSql.slice(schemaSql.indexOf('-- Sign in with Apple')).trim();
  assert.ok(section.length > 300, 'schema.sql has a Sign in with Apple section');
  assert.ok(migration.includes(section), 'the migration holds exactly what schema.sql has');
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE|CREATE|INSERT)\b/im);
  assert.deepEqual(migration.match(/^ALTER TABLE \w+ [A-Z]+ [A-Z]+/gm), ['ALTER TABLE accounts ALTER COLUMN', 'ALTER TABLE accounts ADD COLUMN', 'ALTER TABLE accounts DROP CONSTRAINT', 'ALTER TABLE accounts ADD CONSTRAINT'], 'only the accounts table is touched');
  assert.doesNotMatch(migration, /DROP (TABLE|COLUMN)/i);
});

test('migration 022 on a database that has accounts: existing Google accounts are untouched, it can be run twice, an Apple-only account is allowed, an account with neither is refused, and an Apple id is unique', async (t) => {
  const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  const name = `mig22_${process.pid}_${Date.now()}`;
  try {
    await admin.query(`CREATE SCHEMA ${name}`);
  } catch {
    await admin.end();
    return t.skip('no database reachable');
  }
  await admin.end();
  const p = new pg.Pool({ connectionString: url, options: `-c search_path=${name}` });
  try {
    const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    await p.query(schemaSql.slice(0, schemaSql.indexOf('-- Sign in with Apple')));
    await p.query("INSERT INTO accounts (google_sub, ref, email) VALUES ('g1', 'EXC-AAAA-AAAA', 'a@example.com')");
    const migration = readFileSync(new URL('../migrations/022_apple_sign_in.sql', import.meta.url), 'utf8');
    await p.query(migration);
    await p.query(migration);
    assert.deepEqual((await p.query('SELECT google_sub, apple_sub FROM accounts')).rows, [{ google_sub: 'g1', apple_sub: null }]);
    await p.query("INSERT INTO accounts (apple_sub, ref, email) VALUES ('a1', 'EXC-BBBB-BBBB', 'b@example.com')");
    await assert.rejects(p.query("INSERT INTO accounts (ref, email) VALUES ('EXC-CCCC-CCCC', 'c@example.com')"), /accounts_has_sub/);
    await assert.rejects(p.query("INSERT INTO accounts (apple_sub, ref, email) VALUES ('a1', 'EXC-DDDD-DDDD', 'd@example.com')"), /unique/i);
  } finally {
    await p.end();
    const cleanup = new pg.Pool({ connectionString: url });
    await cleanup.query(`DROP SCHEMA ${name} CASCADE`);
    await cleanup.end();
  }
});
