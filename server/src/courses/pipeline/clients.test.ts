import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTavily, createYoutube, parseChapters } from './clients.ts';

type Call = { url: string; init?: RequestInit };
const fakeFetch = (answer: (c: Call) => { status?: number; body: unknown }) => {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = answer({ url: String(url), init });
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { f, calls };
};

test('Tavily search sends the key as a bearer header, asks for page text, and returns url, title and text', async () => {
  const { f, calls } = fakeFetch(() => ({ body: { results: [{ url: 'https://a.com/x', title: 'A', raw_content: 'full text', content: 'short' }, { url: 'https://b.com/y', title: 'B', content: 'only short' }] } }));
  const tavily = createTavily('secret-key', f);
  const hits = await tavily.search({ query: 'q', includeDomains: ['a.com'], maxResults: 5 });
  assert.deepEqual(hits, [{ url: 'https://a.com/x', title: 'A', text: 'full text' }, { url: 'https://b.com/y', title: 'B', text: 'only short' }]);
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, 'Bearer secret-key');
  const body = JSON.parse(calls[0]!.init!.body as string);
  assert.deepEqual([body.query, body.include_domains, body.max_results, body.include_raw_content], ['q', ['a.com'], 5, 'text']);
});

test('a failed Tavily call is an error that names the status and never the key', async () => {
  const { f } = fakeFetch(() => ({ status: 429, body: {} }));
  await assert.rejects(createTavily('secret-key', f).search({ query: 'q', maxResults: 3 }), (e: Error) => /429/.test(e.message) && !/secret-key/.test(e.message));
});

test('extract returns the page text by url, and nothing for a page it could not read', async () => {
  const { f } = fakeFetch(() => ({ body: { results: [{ url: 'https://a.com/x', raw_content: 'text of a' }], failed_results: [{ url: 'https://b.com/y' }] } }));
  assert.deepEqual(await createTavily('k', f).extract(['https://a.com/x', 'https://b.com/y']), { 'https://a.com/x': 'text of a' });
});

test('chapter markers are read from a description: lines that start with a time', () => {
  const description = 'In this video we debug a service.\n0:00 Intro\n2:05 Reading a stack trace\n1:02:30 Wrap up\nnot a chapter 3:00 in the middle';
  assert.deepEqual(parseChapters(description), [{ at: 0, title: 'Intro' }, { at: 125, title: 'Reading a stack trace' }, { at: 3750, title: 'Wrap up' }]);
  assert.deepEqual(parseChapters('no chapters here'), []);
});

test('YouTube search and details go through the official API; the key stays out of errors; counts and captions are read as numbers and flags', async () => {
  const { f, calls } = fakeFetch((c) =>
    c.url.includes('/search?')
      ? { body: { items: [{ id: { videoId: 'v1' } }, { id: { videoId: 'v2' } }] } }
      : { body: { items: [{ id: 'v1', snippet: { title: 'T', channelTitle: 'C', channelId: 'cid', publishedAt: '2025-01-01T00:00:00Z', description: '0:00 Intro\n3:10 The fix', defaultAudioLanguage: 'en' }, contentDetails: { duration: 'PT12M', caption: 'true' }, statistics: { viewCount: '5000', likeCount: '120' } }] } },
  );
  const yt = createYoutube('yt-key', f);
  assert.deepEqual(await yt.search('debugging'), ['v1', 'v2']);
  const [v] = await yt.videos(['v1', 'v2']);
  assert.deepEqual([v!.id, v!.views, v!.likes, v!.captions, v!.language, v!.chapters!.length], ['v1', 5000, 120, true, 'en', 2]);
  assert.match(calls[0]!.url, /videoCaption=closedCaption/);
  const failing = fakeFetch(() => ({ status: 403, body: {} }));
  await assert.rejects(createYoutube('yt-key', failing.f).search('x'), (e: Error) => /403/.test(e.message) && !/yt-key/.test(e.message));
});
