import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApi, parseLimit, type ApiDeps } from './api.ts';
import type { ArticleReader, ArticleRow } from './db.ts';
import type { LeaderboardStore } from './leaderboard.ts';

const OLD_ARTICLE_KEYS = ['content_type', 'fetched_at', 'id', 'published_at', 'reader_count', 'source_company', 'source_url', 'summary', 'title'];
const ARTICLE_KEYS = [...OLD_ARTICLE_KEYS, 'quiz', 'topic'].sort();
const QUIZ = { questions: [0, 1, 2].map((n) => ({ prompt: `Q${n}?`, options: ['a', 'b', 'c', 'd'].map((o) => `${o}${n}`), correct_index: n })) };

function row(n: number): ArticleRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    source_company: 'NVIDIA',
    source_url: `https://blogs.nvidia.com/blog/post-${n}`,
    content_type: 'Tech Blog',
    title: `Post ${n}`,
    summary: 'A summary.',
    published_at: new Date(Date.UTC(2026, 8, n)).toISOString(),
    fetched_at: '2026-10-04T12:00:00.000Z',
    reader_count: 100 + n,
    quiz: null,
    topic: null,
  };
}

/** A fake reader over rows already sorted newest first; records the limits it was asked for. */
function fakeReader(rows: ArticleRow[]) {
  const limits: number[] = [];
  const reader: ArticleReader = {
    feed: async (limit) => (limits.push(limit), rows.slice(0, limit)),
    getById: async (id) => rows.find((r) => r.id === id),
  };
  return { reader, limits };
}

const noBoard: LeaderboardStore = { record: async () => true, deleteDevice: async () => {}, leaderboard: async () => ({ rows: [], you: null }) };

async function api(overrides: Partial<ApiDeps> = {}) {
  return buildApi({ ping: async () => {}, articles: fakeReader([]).reader, leaderboard: noBoard, ...overrides });
}

test('GET /health answers 200 when the database is reachable', async () => {
  const app = await api();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

test('Scenario: Health check - non-200 when the database is unreachable, without leaking details', async () => {
  const app = await api({
    ping: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    },
  });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 503);
  assert.ok(!res.body.includes('hunter2') && !res.body.includes('10.0.0.5'));
  await app.close();
});

test('allows the app to call the API from another origin', async () => {
  const app = await api();
  const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:8081' } });
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:8081');
  await app.close();
});

test('unknown routes are 404, and only GET is served', async () => {
  const app = await api();
  assert.equal((await app.inject({ method: 'GET', url: '/admin' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/feed' })).statusCode, 404);
  await app.close();
});

test('parseLimit: default 30, capped at 100, invalid values rejected', () => {
  assert.equal(parseLimit(undefined), 30);
  assert.equal(parseLimit(''), 30);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit('500'), 100);
  for (const bad of ['0', '-1', '1.5', 'abc', '10abc', ['5', '6']]) assert.equal(parseLimit(bad), null, String(bad));
});

test('GET /feed returns Article objects with exactly the Article fields', async () => {
  const rows = [row(3), row(2), row(1)];
  const app = await api({ articles: fakeReader(rows).reader });
  const res = await app.inject({ method: 'GET', url: '/feed' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as ArticleRow[];
  assert.equal(body.length, 3);
  for (const a of body) {
    assert.deepEqual(Object.keys(a).sort(), ARTICLE_KEYS);
    assert.equal(typeof a.reader_count, 'number');
    assert.ok(!Number.isNaN(Date.parse(a.published_at)));
  }
  assert.deepEqual(body.map((a) => a.title), ['Post 3', 'Post 2', 'Post 1']);
  await app.close();
});

test('GET /feed passes the limit through, defaults to 30 and caps at 100', async () => {
  const { reader, limits } = fakeReader([]);
  const app = await api({ articles: reader });
  await app.inject({ method: 'GET', url: '/feed' });
  await app.inject({ method: 'GET', url: '/feed?limit=10' });
  await app.inject({ method: 'GET', url: '/feed?limit=1000' });
  assert.deepEqual(limits, [30, 10, 100]);
  await app.close();
});

test('GET /feed rejects a bad limit with 400', async () => {
  const app = await api();
  for (const bad of ['0', '-3', 'ten', '2.5']) {
    const res = await app.inject({ method: 'GET', url: `/feed?limit=${bad}` });
    assert.equal(res.statusCode, 400, bad);
  }
  await app.close();
});

test('GET /feed accepts the user_id the app sends, and ignores it', async () => {
  const { reader, limits } = fakeReader([row(1)]);
  const app = await api({ articles: reader });
  const res = await app.inject({ method: 'GET', url: '/feed?user_id=local-user' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(limits, [30]);
  await app.close();
});

test('GET /feed answers 503 without details when the database fails', async () => {
  const app = await api({ articles: { feed: async () => { throw new Error('relation "articles" does not exist'); }, getById: async () => undefined } });
  const res = await app.inject({ method: 'GET', url: '/feed' });
  assert.equal(res.statusCode, 503);
  assert.ok(!res.body.includes('relation'));
  await app.close();
});

test('GET /articles/:id returns the article, 404 when unknown', async () => {
  const app = await api({ articles: fakeReader([row(1), row(2)]).reader });
  const found = await app.inject({ method: 'GET', url: `/articles/${row(2).id}` });
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), row(2));
  const missing = await app.inject({ method: 'GET', url: '/articles/00000000-0000-4000-8000-999999999999' });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test('GET /articles/:id answers 503 without details when the database fails', async () => {
  const app = await api({ articles: { feed: async () => [], getById: async () => { throw new Error('timeout at 10.0.0.5'); } } });
  const res = await app.inject({ method: 'GET', url: `/articles/${row(1).id}` });
  assert.equal(res.statusCode, 503);
  assert.ok(!res.body.includes('10.0.0.5'));
  await app.close();
});

test('Scenario: quiz and topic are in /feed and /articles/:id, for an article that has them', async () => {
  const withQuiz = { ...row(2), quiz: QUIZ, topic: 'Agents' };
  const app = await api({ articles: fakeReader([withQuiz, row(1)]).reader });
  const feed = (await app.inject({ method: 'GET', url: '/feed' })).json() as ArticleRow[];
  assert.deepEqual(feed[0].quiz, QUIZ);
  assert.equal(feed[0].topic, 'Agents');
  const one = (await app.inject({ method: 'GET', url: `/articles/${withQuiz.id}` })).json() as ArticleRow;
  assert.deepEqual(one.quiz, QUIZ);
  assert.equal(one.topic, 'Agents');
  await app.close();
});

test('an article without a quiz has both fields as null, not missing and not an empty quiz', async () => {
  const app = await api({ articles: fakeReader([row(1)]).reader });
  const [first] = (await app.inject({ method: 'GET', url: '/feed' })).json() as ArticleRow[];
  assert.ok('quiz' in first && 'topic' in first);
  assert.strictEqual(first.quiz, null);
  assert.strictEqual(first.topic, null);
  const one = (await app.inject({ method: 'GET', url: `/articles/${row(1).id}` })).json() as ArticleRow;
  assert.strictEqual(one.quiz, null);
  assert.strictEqual(one.topic, null);
  await app.close();
});

test('every field the app had before is still there with the same value', async () => {
  const withQuiz = { ...row(4), quiz: QUIZ, topic: 'Cloud' };
  const app = await api({ articles: fakeReader([withQuiz]).reader });
  const [a] = (await app.inject({ method: 'GET', url: '/feed' })).json() as Array<Record<string, unknown>>;
  for (const key of OLD_ARTICLE_KEYS) assert.deepEqual(a[key], (withQuiz as unknown as Record<string, unknown>)[key], key);
  assert.deepEqual(Object.keys(a).filter((k) => !OLD_ARTICLE_KEYS.includes(k)).sort(), ['quiz', 'topic']); // nothing else was added
  await app.close();
});
