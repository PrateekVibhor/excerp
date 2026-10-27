import { createAuthApi } from './authApi';

const BASE = 'https://api.example.test/';
const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const api = (fetchFn: jest.Mock, timeoutMs?: number) => createAuthApi(BASE, fetchFn as unknown as typeof fetch, timeoutMs);

describe('authApi.signIn', () => {
  it('posts the Google token as JSON and gives back the session when approved', async () => {
    const fetchFn = jest.fn(async () => json(200, { status: 'approved', session_token: 'tok', expires_at: '2026-11-08T12:00:00.000Z' }));
    expect(await api(fetchFn).signIn('google-id-token')).toEqual({ kind: 'approved', token: 'tok', expires_at: '2026-11-08T12:00:00.000Z' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/google'); // no double slash from the trailing one in the base
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id_token: 'google-id-token' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('pending is pending', async () => {
    expect(await api(jest.fn(async () => json(200, { status: 'pending' }))).signIn('t')).toEqual({ kind: 'pending' });
  });

  it('a 401 or 400 means the token was refused', async () => {
    expect(await api(jest.fn(async () => json(401, { error: 'invalid token' }))).signIn('t')).toEqual({ kind: 'rejected' });
    expect(await api(jest.fn(async () => json(400, { error: 'x' }))).signIn('t')).toEqual({ kind: 'rejected' });
  });

  it('a server that is down, too busy or answers nonsense is "unavailable", never approved or pending', async () => {
    for (const res of [json(503, {}), json(500, {}), json(429, {}), json(404, {}), json(200, null), json(200, {}), json(200, { status: 'approved' }), json(200, { status: 'approved', session_token: '', expires_at: 'x' }), json(200, { status: 'maybe' })]) {
      expect(await api(jest.fn(async () => res)).signIn('t')).toEqual({ kind: 'unavailable' });
    }
  });

  it('no network is "unavailable"', async () => {
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).signIn('t')).toEqual({ kind: 'unavailable' });
  });

  it('a body that cannot be read is "unavailable"', async () => {
    const broken = { status: 200, ok: true, json: async () => { throw new SyntaxError('bad json'); } } as unknown as Response;
    expect(await api(jest.fn(async () => broken)).signIn('t')).toEqual({ kind: 'unavailable' });
  });

  it('a request that takes too long is given up on', async () => {
    const hang = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await api(hang as unknown as jest.Mock, 20).signIn('t')).toEqual({ kind: 'unavailable' });
  });
});

describe('authApi.checkSession', () => {
  it('sends the token as a Bearer header', async () => {
    const fetchFn = jest.fn(async () => json(200, { status: 'approved', expires_at: '2026-11-08T12:00:00.000Z' }));
    expect(await api(fetchFn).checkSession('tok')).toEqual({ kind: 'approved', expires_at: '2026-11-08T12:00:00.000Z' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/session');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('403 is pending, 401 is signed out', async () => {
    expect(await api(jest.fn(async () => json(403, { status: 'pending' }))).checkSession('t')).toEqual({ kind: 'pending' });
    expect(await api(jest.fn(async () => json(401, { error: 'x' }))).checkSession('t')).toEqual({ kind: 'signedOut' });
  });

  it('anything else is "unavailable"', async () => {
    for (const res of [json(503, {}), json(500, {}), json(429, {}), json(200, {}), json(200, { status: 'pending' })]) {
      expect(await api(jest.fn(async () => res)).checkSession('t')).toEqual({ kind: 'unavailable' });
    }
    expect(await api(jest.fn(async () => { throw new Error('offline'); })).checkSession('t')).toEqual({ kind: 'unavailable' });
  });
});

describe('authApi.signOut', () => {
  it('posts once with the token and never rejects', async () => {
    const fetchFn = jest.fn(async () => json(204, null));
    await api(fetchFn).signOut('tok');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/signout');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    await expect(api(jest.fn(async () => { throw new Error('offline'); })).signOut('tok')).resolves.toBeUndefined();
    await expect(api(jest.fn(async () => json(503, {}))).signOut('tok')).resolves.toBeUndefined();
  });
});

describe('authApi never leaks the token', () => {
  it('does not log the Google token, the session token, or what the server said', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    await api(jest.fn(async () => { throw new Error('offline'); })).signIn('SECRET-GOOGLE');
    await api(jest.fn(async () => json(503, {}))).checkSession('SECRET-SESSION');
    await api(jest.fn(async () => { throw new Error('offline'); })).signOut('SECRET-SESSION');
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/SECRET/);
      spy.mockRestore();
    }
  });
});

describe('authApi.deleteAccount', () => {
  it('posts the device id with the session token, and 204 is "deleted"', async () => {
    const fetchFn = jest.fn(async () => json(204, null));
    expect(await api(fetchFn).deleteAccount('tok', 'dev-1')).toBe('deleted');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/delete-account');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ device_id: 'dev-1' });
  });

  it('anything but 204 is "failed", never "deleted": 401, 400, 429, 503, no network, a timeout', async () => {
    for (const res of [json(401, {}), json(400, {}), json(429, {}), json(503, {}), json(200, {})]) {
      expect(await api(jest.fn(async () => res)).deleteAccount('t', 'd')).toBe('failed');
    }
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).deleteAccount('t', 'd')).toBe('failed');
    const hang = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await api(hang as unknown as jest.Mock, 20).deleteAccount('t', 'd')).toBe('failed');
  });
});

describe('authApi: the account reference', () => {
  const REF = 'EXC-7K4Q-92M3';
  it('signIn gives back the reference when the server sends one, and works without one', async () => {
    const withRef = jest.fn(async () => json(200, { status: 'approved', session_token: 'tok', expires_at: 'x', account_ref: REF }));
    expect(await api(withRef).signIn('g')).toEqual({ kind: 'approved', token: 'tok', expires_at: 'x', account_ref: REF });
    const without = jest.fn(async () => json(200, { status: 'approved', session_token: 'tok', expires_at: 'x' }));
    expect(await api(without).signIn('g')).toEqual({ kind: 'approved', token: 'tok', expires_at: 'x' });
  });
  it('checkSession gives back the reference too', async () => {
    const res = await api(jest.fn(async () => json(200, { status: 'approved', expires_at: 'x', account_ref: REF }))).checkSession('t');
    expect(res).toEqual({ kind: 'approved', expires_at: 'x', account_ref: REF });
  });
  it('a reference that is not in the server\'s format is ignored, not trusted', async () => {
    for (const bad of ['alice', '../x', 5, null, 'EXC-1']) {
      const res = await api(jest.fn(async () => json(200, { status: 'approved', expires_at: 'x', account_ref: bad }))).checkSession('t');
      expect(res).toEqual({ kind: 'approved', expires_at: 'x' });
    }
  });
});

describe('authApi.signInWithApple', () => {
  it('posts the identity token and the raw nonce to /auth/apple and gives back the session when approved', async () => {
    const fetchFn = jest.fn(async () => json(200, { status: 'approved', session_token: 'tok', expires_at: '2026-11-08T12:00:00.000Z', account_ref: 'EXC-ABCD-EFGH' }));
    expect(await api(fetchFn).signInWithApple('identity-token', 'raw-nonce')).toEqual({ kind: 'approved', token: 'tok', expires_at: '2026-11-08T12:00:00.000Z', account_ref: 'EXC-ABCD-EFGH' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/apple');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ identity_token: 'identity-token', nonce: 'raw-nonce' });
  });

  it('answers exactly as the Google sign-in does: pending, rejected (401 or 400), and unavailable for anything else', async () => {
    expect(await api(jest.fn(async () => json(200, { status: 'pending' }))).signInWithApple('t', 'n')).toEqual({ kind: 'pending' });
    expect(await api(jest.fn(async () => json(401, {}))).signInWithApple('t', 'n')).toEqual({ kind: 'rejected' });
    expect(await api(jest.fn(async () => json(400, {}))).signInWithApple('t', 'n')).toEqual({ kind: 'rejected' });
    for (const res of [json(503, {}), json(429, {}), json(200, null), json(200, { status: 'approved' })]) expect(await api(jest.fn(async () => res)).signInWithApple('t', 'n')).toEqual({ kind: 'unavailable' });
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).signInWithApple('t', 'n')).toEqual({ kind: 'unavailable' });
  });
});

describe('authApi.deleteAccount with an Apple code', () => {
  it('sends the one-time code only when there is one, so a Google reader\'s request is exactly as before', async () => {
    const withCode = jest.fn(async () => json(204, null));
    expect(await api(withCode).deleteAccount('tok', 'dev-1', 'apple-code')).toBe('deleted');
    expect(JSON.parse(((withCode.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)).toEqual({ device_id: 'dev-1', apple_authorization_code: 'apple-code' });
    const without = jest.fn(async () => json(204, null));
    await api(without).deleteAccount('tok', 'dev-1');
    expect(JSON.parse(((without.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)).toEqual({ device_id: 'dev-1' });
  });
});
