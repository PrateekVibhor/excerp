import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRepositories } from './index';
import { mockArticles } from './mockArticles';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER = 'user-1';
const swipe = (article_id: string, direction: 'left' | 'right' = 'left') => ({
  user_id: USER,
  article_id,
  direction,
  swiped_at: '2026-10-03T10:00:00Z',
});
const apiFetch = (async () =>
  ({ ok: true, status: 200, json: async () => mockArticles }) as Response) as typeof fetch;

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('data source switch', () => {
  it('defaults to mock when no source is set', async () => {
    const { articleRepository } = createRepositories({ source: undefined, apiUrl: undefined });
    expect(await articleRepository.getFeed(USER)).toEqual(mockArticles);
  });

  it('returns Article objects from both sources', async () => {
    const mock = createRepositories({ source: 'mock', apiUrl: undefined });
    const api = createRepositories({ source: 'api', apiUrl: 'https://api.example.test', fetchFn: apiFetch });
    for (const { articleRepository } of [mock, api]) {
      const feed = await articleRepository.getFeed(USER);
      expect(feed.length).toBeGreaterThan(0);
      expect(feed[0]).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String) }));
    }
  });

  it('rejects the api source without a URL', () => {
    expect(() => createRepositories({ source: 'api', apiUrl: undefined })).toThrow('EXPO_PUBLIC_API_URL');
  });

  it('rejects an unknown source', () => {
    expect(() => createRepositories({ source: 'banana', apiUrl: undefined })).toThrow('"mock" or "api"');
  });

  it('does not fall back to mock data when the api is unreachable', async () => {
    const down = (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    const { articleRepository } = createRepositories({ source: 'api', apiUrl: 'https://api.example.test', fetchFn: down });
    await expect(articleRepository.getFeed(USER)).rejects.toThrow();
  });
});

describe('swiped articles stay out of the feed', () => {
  it.each([
    ['mock', undefined],
    ['api', apiFetch],
  ])('with the %s source, across a restart', async (source, fetchFn) => {
    const config = { source, apiUrl: 'https://api.example.test', fetchFn };
    const first = createRepositories(config);
    await first.readingListRepository.recordSwipe(swipe('mock-1', 'right'));
    await first.readingListRepository.add(USER, 'mock-1');
    await first.readingListRepository.recordSwipe(swipe('mock-2', 'left'));

    const restarted = createRepositories(config);
    const ids = (await restarted.articleRepository.getFeed(USER)).map((a) => a.id);
    expect(ids).not.toContain('mock-1');
    expect(ids).not.toContain('mock-2');
    expect(ids).toHaveLength(mockArticles.length - 2);
    expect((await restarted.readingListRepository.list(USER)).map((i) => i.article_id)).toEqual(['mock-1']);
  });

  it('keeps verified articles on the device, and they survive a restart', async () => {
    const storage = { data: new Map<string, string>(), getItem: async (k: string) => storage.data.get(k) ?? null, setItem: async (k: string, v: string) => void storage.data.set(k, v) };
    const config = { source: 'mock', apiUrl: undefined, storage };
    await createRepositories(config).verifiedRepository.add('mock-1', 'Agents');
    const restarted = createRepositories(config);
    expect(await restarted.verifiedRepository.isVerified('mock-1')).toBe(true);
    expect(storage.data.has('swipy:verified')).toBe(true);
  });

  it('wires the leaderboard: a live server when the data source is api, an unreachable stand-in when it is mock', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => (calls.push(url), { ok: true, status: 204, json: async () => ({ rows: [], you: null }) })) as unknown as typeof fetch;
    const live = createRepositories({ source: 'api', apiUrl: 'https://api.example.test', fetchFn });
    expect(await live.leaderboardApi.postVerification({ device_id: 'd', display_name: 'n', article_id: 'a', verified_at: 'v' })).toBe('sent');
    expect(calls).toEqual(['https://api.example.test/verifications']);
    const mock = createRepositories({ source: 'mock', apiUrl: undefined, fetchFn });
    expect(await mock.leaderboardApi.postVerification({ device_id: 'd', display_name: 'n', article_id: 'a', verified_at: 'v' })).toBe('retry');
    await expect(mock.leaderboardApi.getLeaderboard()).rejects.toThrow('live data source');
    expect(calls).toHaveLength(1); // the mock source never touched the network
  });

  it('wires the sync queue to this device\'s id and the profile name, and sends in order', async () => {
    const storage = { data: new Map<string, string>(), getItem: async (k: string) => storage.data.get(k) ?? null, setItem: async (k: string, v: string) => void storage.data.set(k, v) };
    const bodies: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), { ok: true, status: 204, json: async () => ({}) })) as unknown as typeof fetch;
    const repos = createRepositories({ source: 'api', apiUrl: 'https://api.example.test', storage, fetchFn });
    await repos.profileRepository.saveProfile({ display_name: 'Maya Chen', industry: 'Software', interests: ['Cloud'] });
    await repos.syncQueue.enqueue('article-1', '2026-10-06T10:00:00.000Z');
    await repos.syncQueue.enqueue('article-2', '2026-10-06T10:05:00.000Z');
    expect(await repos.syncQueue.flush()).toEqual({ sent: 2, rejected: 0, remaining: 0 });
    const id = await repos.deviceIdRepository.get();
    expect(bodies).toEqual([
      { device_id: id, display_name: 'Maya Chen', article_id: 'article-1', verified_at: '2026-10-06T10:00:00.000Z' },
      { device_id: id, display_name: 'Maya Chen', article_id: 'article-2', verified_at: '2026-10-06T10:05:00.000Z' },
    ]);
  });
});
