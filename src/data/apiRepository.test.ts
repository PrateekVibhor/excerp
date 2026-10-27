import { createApiRepository, createLeaderboardApi } from './apiRepository';
import { mockArticles } from './mockArticles';

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('apiRepository', () => {
  it('getFeed returns Article objects and sends the user id', async () => {
    const fetchFn = jest.fn(async (_url: string) => jsonResponse(mockArticles));
    const repo = createApiRepository('https://api.example.test/', fetchFn as unknown as typeof fetch);
    const feed = await repo.getFeed('user 1');
    expect(feed).toEqual(mockArticles);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.test/feed?user_id=user%201');
  });

  it('getById returns the article, or undefined on 404', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.endsWith('/mock-1') ? jsonResponse(mockArticles[0]) : jsonResponse({}, 404),
    );
    const repo = createApiRepository('https://api.example.test', fetchFn as unknown as typeof fetch);
    expect((await repo.getById('mock-1'))?.id).toBe('mock-1');
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('accepts articles with the Feature 8 fields, with a quiz, with nulls, or without them at all', async () => {
    const quiz = { questions: [0, 1, 2].map((n) => ({ prompt: `Q${n}?`, options: ['a', 'b', 'c', 'd'], correct_index: n })) };
    const { quiz: _q, topic: _t, ...plain } = mockArticles[2]; // what an older server sends: neither field
    const body = [{ ...mockArticles[0], quiz, topic: 'Agents' }, { ...mockArticles[1], quiz: null, topic: null }, plain];
    const repo = createApiRepository('https://api.example.test', (async () => jsonResponse(body)) as typeof fetch);
    const feed = await repo.getFeed('u');
    expect(feed).toHaveLength(3);
    expect(feed[0].quiz).toEqual(quiz);
    expect(feed[1].quiz).toBeNull();
    expect(feed[2].quiz).toBeUndefined(); // an older server: no quiz, no problem
    const one = createApiRepository('https://api.example.test', (async () => jsonResponse(body[0])) as typeof fetch);
    expect((await one.getById('x'))?.topic).toBe('Agents');
  });

  it('throws on a server error instead of returning data', async () => {
    const repo = createApiRepository('https://api.example.test', (async () => jsonResponse({}, 500)) as typeof fetch);
    await expect(repo.getFeed('u')).rejects.toThrow('status 500');
  });

  it('rejects when the network is down', async () => {
    const repo = createApiRepository('https://api.example.test', (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch);
    await expect(repo.getFeed('u')).rejects.toThrow('Network request failed');
  });

  it('rejects a malformed response', async () => {
    const repo = createApiRepository('https://api.example.test', (async () => jsonResponse({ nope: true })) as typeof fetch);
    await expect(repo.getFeed('u')).rejects.toThrow('Unexpected response');
  });

  it('times out instead of hanging when the server never answers', async () => {
    jest.useFakeTimers();
    try {
      const hang = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
      const repo = createApiRepository('https://api.example.test', hang);
      const result = expect(repo.getFeed('u')).rejects.toThrow('aborted');
      await jest.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('leaderboard api: postVerification', () => {
  const verification = { device_id: '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', display_name: 'Maya Chen', article_id: '5d1e6c2a-9a30-4c52-8d8e-1f0a7b2c3d44', verified_at: '2026-10-06T11:59:00.000Z' };
  const answering = (status: number) => jest.fn(async (_url: string, _init?: RequestInit) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }) as Response);
  const api = (fetchFn: jest.Mock) => createLeaderboardApi('https://api.example.test/', fetchFn as unknown as typeof fetch);

  it('posts the verification as JSON to /verifications', async () => {
    const fetchFn = answering(204);
    await api(fetchFn).postVerification(verification);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.test/verifications');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual(verification);
    expect(init?.signal).toBeDefined();
  });

  it('204 means it was sent', async () => {
    expect(await api(answering(204)).postVerification(verification)).toBe('sent');
  });

  it('400, 413, 415 and 422 mean the server will never accept it', async () => {
    for (const status of [400, 413, 415, 422]) expect(await api(answering(status)).postVerification(verification)).toBe('rejected');
  });

  it('429, 5xx, a 404 from a server not yet updated, and other statuses mean try again later', async () => {
    for (const status of [429, 500, 502, 503, 504, 404, 401, 403, 408, 301]) expect(await api(answering(status)).postVerification(verification)).toBe('retry');
  });

  it('no network, or a network failure part-way, means try again later and never throws', async () => {
    const down = jest.fn(async () => { throw new TypeError('Network request failed'); });
    expect(await createLeaderboardApi('https://api.example.test', down as unknown as typeof fetch).postVerification(verification)).toBe('retry');
  });

  it('a reply that takes too long is given up on, as "try again later"', async () => {
    jest.useFakeTimers();
    try {
      const hang = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
      const pending = createLeaderboardApi('https://api.example.test', hang as unknown as typeof fetch).postVerification(verification);
      await jest.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe('retry');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('leaderboard api: getLeaderboard', () => {
  const row = (rank: number, name: string, count: number, is_you = false) => ({ rank, display_name: name, count, is_you });
  const reply = (body: unknown, status = 200) => jest.fn(async (_url: string, _init?: RequestInit) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response);
  const api = (fetchFn: jest.Mock) => createLeaderboardApi('https://api.example.test/', fetchFn as unknown as typeof fetch);

  it('asks for the board, with the device id when there is one, and returns the rows and own row', async () => {
    const body = { rows: [row(1, 'Maya', 3), row(2, 'Daniel', 1, true)], you: row(2, 'Daniel', 1, true) };
    const fetchFn = reply(body);
    expect(await api(fetchFn).getLeaderboard('3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90')).toEqual(body);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.test/leaderboard?device_id=3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90');
    expect(fetchFn.mock.calls[0][1]?.method).toBe('GET');
  });

  it('without a device id there is no query, and own row is null', async () => {
    const fetchFn = reply({ rows: [], you: null });
    expect(await api(fetchFn).getLeaderboard()).toEqual({ rows: [], you: null });
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.test/leaderboard');
  });

  it('keeps only the fields it knows, so nothing extra the server sends is passed on', async () => {
    const extra = { device_id: 'secret', verified_at: 'x' };
    const result = await api(reply({ rows: [{ ...row(1, 'Maya', 3), ...extra }], you: { ...row(1, 'Maya', 3, true), ...extra }, other: 1 })).getLeaderboard();
    expect(result).toEqual({ rows: [row(1, 'Maya', 3)], you: row(1, 'Maya', 3, true) });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(Object.keys(result).sort()).toEqual(['rows', 'you']);
    expect(Object.keys(result.rows[0]).sort()).toEqual(['count', 'display_name', 'is_you', 'rank']);
  });

  it('a server error, an unreachable server, or a reply that is not a board all throw, so the screen can say it cannot load', async () => {
    for (const status of [429, 500, 503, 404]) await expect(api(reply({}, status)).getLeaderboard()).rejects.toThrow(`status ${status}`);
    await expect(createLeaderboardApi('https://x.test', (async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch).getLeaderboard()).rejects.toThrow('Network request failed');
    for (const bad of [null, {}, { rows: 'no' }, { rows: [], you: undefined }, { rows: [{ rank: '1' }], you: null }, { rows: [], you: { rank: 1 } }, { rows: [row(1, 'Maya', 3)], you: 5 }, [], 'text']) {
      await expect(api(reply(bad)).getLeaderboard()).rejects.toThrow('Unexpected response from /leaderboard');
    }
  });

  it('a device id is encoded into the query', async () => {
    const fetchFn = reply({ rows: [], you: null });
    await api(fetchFn).getLeaderboard('a b&c');
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.test/leaderboard?device_id=a%20b%26c');
  });
});
