import { createAccountApi } from './accountApi';

const BASE = 'https://api.example.test/';
const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const api = (fetchFn: jest.Mock, timeoutMs?: number) => createAccountApi(BASE, fetchFn as unknown as typeof fetch, timeoutMs);
const good = { cursor: 3, changes: { profile: null, reading_list: [{ article_id: 'a', saved_at: 't', removed: false, updated_at: 't' }], verified: [{ article_id: 'b', verified_at: 't', topic: 'Cloud' }] } };

describe('accountApi.sync', () => {
  it('posts the cursor and the changes with the session token, and reads the answer', async () => {
    const fetchFn = jest.fn(async () => json(200, good));
    const changes = { reading_list: [{ article_id: 'a', saved_at: 't', removed: false, updated_at: 't' }] };
    expect(await api(fetchFn).sync('tok', 2, changes)).toEqual({ kind: 'ok', value: good });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/me/sync');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ cursor: 2, changes });
  });

  it('reads a profile in the answer', async () => {
    const profile = { display_name: 'Maya', industry: 'Software', interests: ['Cloud'], updated_at: 't' };
    const res = await api(jest.fn(async () => json(200, { ...good, changes: { ...good.changes, profile } }))).sync('t', 0, {});
    expect(res).toEqual({ kind: 'ok', value: { ...good, changes: { ...good.changes, profile } } });
  });

  it('401, 403 and 400 are told apart; everything else is "failed"', async () => {
    expect(await api(jest.fn(async () => json(401, {}))).sync('t', 0, {})).toEqual({ kind: 'unauthorized' });
    expect(await api(jest.fn(async () => json(403, {}))).sync('t', 0, {})).toEqual({ kind: 'forbidden' });
    expect(await api(jest.fn(async () => json(400, {}))).sync('t', 0, {})).toEqual({ kind: 'invalid' });
    for (const res of [json(500, {}), json(503, {}), json(429, {}), json(404, {})]) expect(await api(jest.fn(async () => res)).sync('t', 0, {})).toEqual({ kind: 'failed' });
  });

  it('an answer that is not what the server sends is "failed", never applied', async () => {
    const odd = [null, {}, { cursor: 'x', changes: good.changes }, { cursor: 1.5, changes: good.changes }, { cursor: 1 }, { cursor: 1, changes: { profile: null, reading_list: 'no', verified: [] } },
      { cursor: 1, changes: { profile: null, reading_list: [{ article_id: 'a' }], verified: [] } }, { cursor: 1, changes: { profile: { display_name: 'x' }, reading_list: [], verified: [] } }];
    for (const body of odd) expect(await api(jest.fn(async () => json(200, body))).sync('t', 0, {})).toEqual({ kind: 'failed' });
  });

  it('no network, a body that cannot be read, or a request that takes too long is "failed"', async () => {
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).sync('t', 0, {})).toEqual({ kind: 'failed' });
    const broken = { status: 200, ok: true, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response;
    expect(await api(jest.fn(async () => broken)).sync('t', 0, {})).toEqual({ kind: 'failed' });
    const hang = jest.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await api(hang as unknown as jest.Mock, 20).sync('t', 0, {})).toEqual({ kind: 'failed' });
  });
});

describe('accountApi.skips', () => {
  it('posts the article ids, and 204 is ok', async () => {
    const fetchFn = jest.fn(async () => json(204, null));
    expect(await api(fetchFn).skips('tok', ['a', 'a', 'b'])).toEqual({ kind: 'ok', value: null });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/me/skips');
    expect(JSON.parse(init.body as string)).toEqual({ article_ids: ['a', 'a', 'b'] });
  });
  it('refusals and failures are told apart, and only 204 counts as done', async () => {
    expect(await api(jest.fn(async () => json(401, {}))).skips('t', ['a'])).toEqual({ kind: 'unauthorized' });
    expect(await api(jest.fn(async () => json(403, {}))).skips('t', ['a'])).toEqual({ kind: 'forbidden' });
    expect(await api(jest.fn(async () => json(400, {}))).skips('t', ['a'])).toEqual({ kind: 'invalid' });
    for (const res of [json(200, {}), json(429, {}), json(503, {})]) expect(await api(jest.fn(async () => res)).skips('t', ['a'])).toEqual({ kind: 'failed' });
    expect(await api(jest.fn(async () => { throw new Error('offline'); })).skips('t', ['a'])).toEqual({ kind: 'failed' });
  });
});

describe('accountApi.claimDevice', () => {
  it('posts the device id and reads how many were moved', async () => {
    const fetchFn = jest.fn(async () => json(200, { folded: 2 }));
    expect(await api(fetchFn).claimDevice('tok', 'dev-1')).toEqual({ kind: 'ok', value: { folded: 2 } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/me/claim-device');
    expect(JSON.parse(init.body as string)).toEqual({ device_id: 'dev-1' });
  });
  it('409 (another account has it) is "invalid": nothing will ever change that; other failures are retried later', async () => {
    expect(await api(jest.fn(async () => json(409, {}))).claimDevice('t', 'd')).toEqual({ kind: 'invalid' });
    expect(await api(jest.fn(async () => json(401, {}))).claimDevice('t', 'd')).toEqual({ kind: 'unauthorized' });
    expect(await api(jest.fn(async () => json(503, {}))).claimDevice('t', 'd')).toEqual({ kind: 'failed' });
    expect(await api(jest.fn(async () => json(200, {}))).claimDevice('t', 'd')).toEqual({ kind: 'failed' });
  });
});
