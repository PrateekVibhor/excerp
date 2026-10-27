import { createSocialApi } from './socialApi';

const BASE = 'https://api.example.test/';
const json = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body }) as unknown as Response;
const api = (fetchFn: jest.Mock, token: string | null = 'tok', timeoutMs?: number) => createSocialApi(BASE, async () => token, fetchFn as unknown as typeof fetch, timeoutMs);
const call = (fetchFn: jest.Mock) => fetchFn.mock.calls[0] as unknown as [string, RequestInit];

const settings = { discoverable: true, accepts_messages: false, adult_confirmed: true, terms_accepted: true };
const reader = { public_id: 'p1', display_name: 'Bob', industry: 'Finance', interests: ['Cloud'], shared_interests: 1, action: 'saved', can_message: true };
const other = { public_id: 'p2', display_name: 'Sam', industry: 'Media', interests: [], deleted: false };
const message = { id: 'm1', from: 'them', subject: 'Hi', body: 'Hello', created_at: '2026-10-10T12:00:00.000Z', read: false };
const conversation = { id: 'c1', state: 'request', role: 'recipient', other, article_id: null, created_at: message.created_at, last_message_at: message.created_at, unread: 1, last_message: message };

describe('socialApi: how it asks', () => {
  it('sends the session token, and a JSON body only when there is one', async () => {
    const fetchFn = jest.fn(async () => json(200, settings));
    await api(fetchFn).getSettings();
    let [url, init] = call(fetchFn);
    expect(url).toBe('https://api.example.test/me/messaging-settings');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    const put = jest.fn(async () => json(200, settings));
    await api(put).putSettings({ discoverable: true, confirm_adult: true, accept_terms: true });
    [url, init] = call(put);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ discoverable: true, confirm_adult: true, accept_terms: true });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('with no session it does not ask at all', async () => {
    const fetchFn = jest.fn();
    expect(await api(fetchFn, null).inbox()).toEqual({ kind: 'unauthorized' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('each call goes to its own route, and ids are put in the path safely', async () => {
    const cases: Array<[(a: ReturnType<typeof api>) => Promise<unknown>, string, string]> = [
      [(a) => a.readers('a/b'), 'GET', '/articles/a%2Fb/readers'],
      [(a) => a.card('p1'), 'GET', '/readers/p1'],
      [(a) => a.blocks(), 'GET', '/me/blocks'],
      [(a) => a.unblock('p1'), 'DELETE', '/me/blocks/p1'],
      [(a) => a.inbox(), 'GET', '/me/inbox'],
      [(a) => a.thread('c1'), 'GET', '/me/conversations/c1'],
      [(a) => a.accept('c1'), 'POST', '/me/conversations/c1/accept'],
      [(a) => a.decline('c1'), 'POST', '/me/conversations/c1/decline'],
      [(a) => a.markRead('m1'), 'POST', '/me/messages/m1/read'],
      [(a) => a.hide('m1'), 'DELETE', '/me/messages/m1'],
    ];
    for (const [run, method, path] of cases) {
      const fetchFn = jest.fn(async () => json(204, null));
      await run(api(fetchFn));
      const [url, init] = call(fetchFn);
      expect([init.method, url.replace('https://api.example.test', '')]).toEqual([method, path]);
    }
  });

  it('a request, a reply and a report are sent as the server expects them', async () => {
    let fetchFn = jest.fn(async () => json(204, null));
    await api(fetchFn).send({ to: 'p1', subject: 'Hi', body: 'Hello', articleId: 'a1' });
    expect(JSON.parse(call(fetchFn)[1].body as string)).toEqual({ to: 'p1', subject: 'Hi', body: 'Hello', article_id: 'a1' });
    fetchFn = jest.fn(async () => json(204, null));
    await api(fetchFn).send({ conversationId: 'c1', subject: '', body: 'Reply' });
    expect(JSON.parse(call(fetchFn)[1].body as string)).toEqual({ conversation_id: 'c1', subject: '', body: 'Reply' });
    fetchFn = jest.fn(async () => json(204, null));
    await api(fetchFn).report({ messageId: 'm1', reason: 'scam', note: '  a note  ', alsoBlock: true });
    expect(JSON.parse(call(fetchFn)[1].body as string)).toEqual({ message_id: 'm1', reason: 'scam', note: 'a note', also_block: true });
    fetchFn = jest.fn(async () => json(204, null));
    await api(fetchFn).report({ publicId: 'p1', reason: 'spam', note: '   ' });
    expect(JSON.parse(call(fetchFn)[1].body as string)).toEqual({ public_id: 'p1', reason: 'spam' }); // an empty note is not sent
  });
});

describe('socialApi: what comes back', () => {
  it('reads each kind of answer', async () => {
    expect(await api(jest.fn(async () => json(200, settings))).getSettings()).toEqual({ kind: 'ok', value: settings });
    expect(await api(jest.fn(async () => json(200, { count: 4, readers: [reader] }))).readers('a')).toEqual({ kind: 'ok', value: { count: 4, readers: [reader] } });
    expect(await api(jest.fn(async () => json(200, { public_id: 'p1', display_name: 'Bob', industry: 'Finance', interests: [], verified_count: 2, can_message: false }))).card('p1')).toMatchObject({ kind: 'ok' });
    expect(await api(jest.fn(async () => json(200, { blocks: [{ public_id: 'p1', display_name: 'Bob', blocked_at: 't' }] }))).blocks()).toEqual({ kind: 'ok', value: [{ public_id: 'p1', display_name: 'Bob', blocked_at: 't' }] });
    const inbox = { cursor: 5, unread: 1, requests: [conversation], conversations: [], sent: [] };
    expect(await api(jest.fn(async () => json(200, inbox))).inbox()).toEqual({ kind: 'ok', value: inbox });
    const thread = { ...conversation, messages: [message] };
    expect(await api(jest.fn(async () => json(200, thread))).thread('c1')).toEqual({ kind: 'ok', value: thread });
    expect(await api(jest.fn(async () => json(204, null))).block('p1')).toEqual({ kind: 'ok', value: null });
  });

  it('a deleted account in a conversation is read as it is sent', async () => {
    const gone = { ...conversation, other: { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true } };
    const res = await api(jest.fn(async () => json(200, { cursor: 1, unread: 0, requests: [gone], conversations: [], sent: [] }))).inbox();
    expect(res).toMatchObject({ kind: 'ok' });
  });

  it('401 is "unauthorized"; 400, 403, 404, 409 and 429 are refusals that keep the server\'s code', async () => {
    expect(await api(jest.fn(async () => json(401, {}))).inbox()).toEqual({ kind: 'unauthorized' });
    for (const status of [400, 403, 404, 409, 429]) {
      expect(await api(jest.fn(async () => json(status, { error: 'some_code' }))).send({ to: 'p', subject: '', body: 'x' })).toEqual({ kind: 'refused', status, code: 'some_code' });
    }
    expect(await api(jest.fn(async () => json(403, null))).inbox()).toEqual({ kind: 'refused', status: 403, code: '' });
  });

  it('anything else is "failed": a server error, no network, a slow server, an answer that is not what was promised', async () => {
    for (const res of [json(500, {}), json(503, {}), json(200, null), json(200, {}), json(200, { count: 'x', readers: [] }), json(200, { count: 1, readers: [{ public_id: 1 }] }), json(200, { cursor: 1, unread: 0, requests: [{ id: 'x' }], conversations: [], sent: [] })]) {
      expect(await api(jest.fn(async () => res)).readers('a')).toEqual({ kind: 'failed' });
    }
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).inbox()).toEqual({ kind: 'failed' });
    const hang = jest.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await api(hang as unknown as jest.Mock, 'tok', 20).inbox()).toEqual({ kind: 'failed' });
  });
});
