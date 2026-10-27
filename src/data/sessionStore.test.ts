import { createSessionStore, SESSION_KEY, type SecureStorage, type StoredSession } from './sessionStore';

const SESSION: StoredSession = { token: 'abc_DEF-123', expires_at: '2026-11-08T12:00:00.000Z', last_approved_at: '2026-10-09T12:00:00.000Z' };

function fake(initial: Record<string, string> = {}) {
  const data = { ...initial };
  const storage: SecureStorage & { data: Record<string, string> } = {
    data,
    getItemAsync: jest.fn(async (key: string) => data[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { data[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete data[key]; }),
  };
  return storage;
}

describe('sessionStore', () => {
  it('the key uses only characters secure storage accepts (letters, digits, ".", "-", "_")', () => {
    expect(SESSION_KEY).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('gives back what was saved', async () => {
    const store = createSessionStore(fake());
    await store.save(SESSION);
    expect(await store.load()).toEqual(SESSION);
  });

  it('is empty before anything is saved', async () => {
    expect(await createSessionStore(fake()).load()).toBeNull();
  });

  it('clear removes the session', async () => {
    const storage = fake();
    const store = createSessionStore(storage);
    await store.save(SESSION);
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(storage.data[SESSION_KEY]).toBeUndefined();
  });

  it('clearing when nothing is stored does not fail', async () => {
    await expect(createSessionStore(fake()).clear()).resolves.toBeUndefined();
  });

  it('a stored value that is not valid JSON is treated as signed out, not a crash', async () => {
    expect(await createSessionStore(fake({ [SESSION_KEY]: '{not json' })).load()).toBeNull();
  });

  it('a stored value of the wrong shape is treated as signed out', async () => {
    for (const bad of [
      'null', '42', '"text"', '[]', '{}',
      JSON.stringify({ ...SESSION, token: '' }),
      JSON.stringify({ ...SESSION, token: 7 }),
      JSON.stringify({ ...SESSION, expires_at: 'not a date' }),
      JSON.stringify({ ...SESSION, last_approved_at: undefined }),
      JSON.stringify({ token: 'x' }),
    ]) {
      expect(await createSessionStore(fake({ [SESSION_KEY]: bad })).load()).toBeNull();
    }
  });

  it('extra fields in the stored value are dropped', async () => {
    const stored = JSON.stringify({ ...SESSION, email: 'someone@example.com', extra: 1 });
    expect(await createSessionStore(fake({ [SESSION_KEY]: stored })).load()).toEqual(SESSION);
  });

  it('secure storage that cannot be read gives signed out, never a rejection', async () => {
    const storage = fake();
    storage.getItemAsync = jest.fn(async () => { throw new Error('keychain locked'); });
    expect(await createSessionStore(storage).load()).toBeNull();
  });

  it('clear never rejects, even if secure storage fails', async () => {
    const storage = fake();
    storage.deleteItemAsync = jest.fn(async () => { throw new Error('keychain locked'); });
    await expect(createSessionStore(storage).clear()).resolves.toBeUndefined();
  });

  it('a save that fails is reported, so the app can still let the reader in for this run', async () => {
    const storage = fake();
    storage.setItemAsync = jest.fn(async () => { throw new Error('keychain full'); });
    await expect(createSessionStore(storage).save(SESSION)).rejects.toThrow('keychain full');
  });
});

describe('sessionStore: the account reference', () => {
  const WITH_REF: StoredSession = { ...SESSION, account_ref: 'EXC-7K4Q-92M3' };

  it('keeps the account reference with the session', async () => {
    const store = createSessionStore(fake());
    await store.save(WITH_REF);
    expect(await store.load()).toEqual(WITH_REF);
  });

  it('a session saved before accounts loads without one', async () => {
    const storage = fake({ [SESSION_KEY]: JSON.stringify(SESSION) });
    expect(await createSessionStore(storage).load()).toEqual(SESSION);
  });

  it('a reference that is not in the server\'s format is dropped, so nothing odd can become part of a storage key', async () => {
    for (const bad of ['alice@example.com', '../x', 'EXC-1', 42, null, '']) {
      const storage = fake({ [SESSION_KEY]: JSON.stringify({ ...SESSION, account_ref: bad }) });
      expect(await createSessionStore(storage).load()).toEqual(SESSION);
    }
  });

  it('keeps that a session came from Apple, and nothing for a Google one; anything else is dropped', async () => {
    const store = createSessionStore(fake());
    await store.save({ ...SESSION, provider: 'apple' });
    expect(await store.load()).toEqual({ ...SESSION, provider: 'apple' });
    await store.save({ ...SESSION, provider: 'google' });
    expect(await store.load()).toEqual(SESSION); // a Google session is stored exactly as it always was
    const odd = fake({ [SESSION_KEY]: JSON.stringify({ ...SESSION, provider: 'facebook' }) });
    expect(await createSessionStore(odd).load()).toEqual(SESSION);
  });
});
