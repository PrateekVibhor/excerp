import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApi } from './api.ts';
import type { ArticleReader } from './db.ts';
import type { LeaderboardStore } from './leaderboard.ts';
import type { RateLimiter } from './rateLimit.ts';

const PROXY = '172.30.0.10';
const body = JSON.stringify({ device_id: '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', display_name: 'Maya', article_id: '5d1e6c2a-9a30-4c52-8d8e-1f0a7b2c3d44', verified_at: '2026-10-06T11:59:00.000Z' });
const reader: ArticleReader = { feed: async () => [], getById: async () => undefined };
const board: LeaderboardStore = { record: async () => true, deleteDevice: async () => {}, leaderboard: async () => ({ rows: [], you: null }) };

/** Posts one verification as if the connection came from `remoteAddress`, and returns the address the per-address limit counted. */
async function countedAddress(trustProxy: string[] | undefined, remoteAddress: string, forwardedFor?: string) {
  const keys: string[] = [];
  const ipLimiter: RateLimiter = { take: (key) => (keys.push(key), true) };
  const app = await buildApi({ ping: async () => {}, articles: reader, leaderboard: board, ipLimiter, trustProxy });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  await app.inject({ method: 'POST', url: '/verifications', headers, remoteAddress, payload: body });
  return keys[0];
}

test('behind the proxy, the address that is counted is the visitor in X-Forwarded-For, not the proxy', async () => {
  assert.equal(await countedAddress([PROXY], PROXY, '203.0.113.7'), '203.0.113.7');
});

test('two visitors behind the proxy are counted separately', async () => {
  assert.notEqual(await countedAddress([PROXY], PROXY, '203.0.113.7'), await countedAddress([PROXY], PROXY, '203.0.113.8'));
});

test('a request that does not come from the proxy cannot choose its own address', async () => {
  assert.equal(await countedAddress([PROXY], '198.51.100.9', '203.0.113.7'), '198.51.100.9');
});

test('with no proxy configured, X-Forwarded-For is ignored', async () => {
  assert.equal(await countedAddress(undefined, '198.51.100.9', '203.0.113.7'), '198.51.100.9');
  assert.equal(await countedAddress([], '198.51.100.9', '203.0.113.7'), '198.51.100.9');
});

test('a request from the proxy with no X-Forwarded-For is counted as the proxy itself', async () => {
  assert.equal(await countedAddress([PROXY], PROXY), PROXY);
});
