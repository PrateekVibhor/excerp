import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDeviceIdRepository, newDeviceId, randomBytes, type RandomBytes } from './deviceId';
import { createRepositories } from './index';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const KEY = 'swipy:device_id';
// The same pattern the server's table check uses, so an id that passes here is accepted there.
const SERVER_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A new repository over the same storage stands in for an app restart.
const open = () => createDeviceIdRepository(AsyncStorage);
/** A spy on the shared storage mock that starts with no calls, since the mock remembers earlier tests'. */
const watch = (method: 'getItem' | 'setItem') => {
  const spy = jest.spyOn(AsyncStorage, method);
  spy.mockClear();
  return spy;
};
const fixedBytes = (...bytes: number[]): RandomBytes => () => Uint8Array.from([...bytes, ...Array(16).fill(0)].slice(0, 16));

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('newDeviceId', () => {
  it('is a version 4 UUID in lower case, which the server accepts', () => {
    for (let i = 0; i < 200; i++) {
      const id = newDeviceId();
      expect(id).toMatch(V4);
      expect(id).toMatch(SERVER_RULE);
      expect(id).toHaveLength(36);
    }
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    expect(newDeviceId(() => new Uint8Array(16).fill(0x00))).toBe('00000000-0000-4000-8000-000000000000');
    expect(newDeviceId(() => new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(newDeviceId(fixedBytes(0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88))).toBe('12345678-9abc-4ef0-9122-334455667788');
  });

  it('asks its source for 16 bytes and uses all of them', () => {
    const asked: number[] = [];
    const id = newDeviceId((n) => (asked.push(n), Uint8Array.from({ length: n }, (_, i) => i + 1)));
    expect(asked).toEqual([16]);
    expect(id).toBe('01020304-0506-4708-890a-0b0c0d0e0f10'); // bytes 1 to 16, with the version and variant bits set
  });

  it('gives a different id every time', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newDeviceId()));
    expect(ids.size).toBe(1000);
  });
});

describe('randomBytes', () => {
  it('uses the secure source when the platform has one', () => {
    const original = (globalThis as { crypto?: unknown }).crypto;
    const getRandomValues = jest.fn((array: Uint8Array) => array.fill(7));
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues }, configurable: true });
    try {
      expect(Array.from(randomBytes(4))).toEqual([7, 7, 7, 7]);
      expect(getRandomValues).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  it('falls back to Math.random when there is none, as in the app\'s runtime', () => {
    const original = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const random = jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.999999);
    try {
      expect(Array.from(randomBytes(3))).toEqual([0, 128, 255]);
      expect(random).toHaveBeenCalledTimes(3);
      expect(newDeviceId()).toMatch(V4); // and it still makes a valid id
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  it('a platform with crypto but no getRandomValues also falls back', () => {
    const original = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      expect(randomBytes(16)).toHaveLength(16);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  it('gives the length asked for', () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(16)).toHaveLength(16);
  });
});

describe('device id repository', () => {
  it('makes an id on first use, keeps it under swipy:device_id, and returns it', async () => {
    const id = await open().get();
    expect(id).toMatch(V4);
    expect(await AsyncStorage.getItem(KEY)).toBe(id);
  });

  it('Scenario: same id after a restart - a new repository over the same storage gives the same id', async () => {
    const first = await open().get();
    expect(await open().get()).toBe(first);
    expect(await open().get()).toBe(first);
  });

  it('asks the store once per run, then answers from memory', async () => {
    const repo = open();
    await repo.get();
    const getItem = watch('getItem');
    const setItem = watch('setItem');
    await repo.get();
    await repo.get();
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('two callers asking at once on a new device get the same id, and it is written once', async () => {
    const setItem = watch('setItem');
    const repo = open();
    const ids = await Promise.all([repo.get(), repo.get(), repo.get()]);
    expect(new Set(ids).size).toBe(1);
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
  });

  it('never rewrites an id that is already stored', async () => {
    const id = newDeviceId();
    await AsyncStorage.setItem(KEY, id);
    const setItem = watch('setItem');
    expect(await open().get()).toBe(id);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('an id stored in upper case is accepted and returned in lower case', async () => {
    const id = newDeviceId();
    await AsyncStorage.setItem(KEY, id.toUpperCase());
    expect(await open().get()).toBe(id);
  });

  it('Scenario: unreadable store - a failed read gives a working id without a crash, and writes nothing over what may be there', async () => {
    const real = newDeviceId();
    await AsyncStorage.setItem(KEY, real);
    watch('getItem').mockRejectedValueOnce(new Error('disk error'));
    const setItem = watch('setItem');
    const repo = open();
    const id = await repo.get();
    expect(id).toMatch(V4);
    expect(id).not.toBe(real);
    expect(setItem).not.toHaveBeenCalled(); // the stored id was not overwritten
    expect(await repo.get()).toBe(id); // the same temporary id for the rest of this run
    expect(await AsyncStorage.getItem(KEY)).toBe(real);
    expect(await open().get()).toBe(real); // and the next run finds the real one again
  });

  it.each([['', 'empty'], ['not-a-uuid', 'text'], ['{"a":1}', 'an object'], ['3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a9', 'a UUID one character short'], ['3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90x', 'a UUID with something after it'], [' 3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', 'a UUID with a space before it']])(
    'a stored value that is not an id (%j, %s) is replaced by a new one',
    async (garbage) => {
      await AsyncStorage.setItem(KEY, garbage);
      const id = await open().get();
      expect(id).toMatch(V4);
      expect(await AsyncStorage.getItem(KEY)).toBe(id);
      expect(await open().get()).toBe(id);
    },
  );

  it('a failed write still gives a working id for this run, and the next run makes another', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage full'));
    const repo = open();
    const id = await repo.get();
    expect(id).toMatch(V4);
    expect(await repo.get()).toBe(id);
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    const next = await open().get();
    expect(next).toMatch(V4);
    expect(await AsyncStorage.getItem(KEY)).toBe(next); // this time it was saved
  });

  it('never rejects, whatever the store does', async () => {
    const broken = { getItem: () => { throw new Error('sync throw'); }, setItem: () => Promise.reject(new Error('no')) } as never;
    await expect(createDeviceIdRepository(broken).get()).resolves.toMatch(V4);
    const brokenWrite = { getItem: async () => null, setItem: () => { throw new Error('sync throw'); } } as never;
    await expect(createDeviceIdRepository(brokenWrite).get()).resolves.toMatch(V4);
  });

  it('uses the random source it is given', async () => {
    const id = await createDeviceIdRepository(AsyncStorage, () => new Uint8Array(16).fill(0xab)).get();
    expect(id).toBe('abababab-abab-4bab-abab-abababababab');
  });

  it('is not tied to the profile: changing or clearing the profile keeps the id', async () => {
    const id = await open().get();
    await AsyncStorage.setItem('swipy:profile', JSON.stringify({ display_name: 'Maya', industry: 'Software', interests: ['Cloud'] }));
    await AsyncStorage.removeItem('swipy:profile');
    expect(await open().get()).toBe(id);
  });

  it('makes no network request', async () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    try {
      await open().get();
    } finally {
      global.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('device id through the app\'s repositories', () => {
  it('is available as deviceIdRepository and survives a restart', async () => {
    const storage = { data: new Map<string, string>(), getItem: async (k: string) => storage.data.get(k) ?? null, setItem: async (k: string, v: string) => void storage.data.set(k, v) };
    const config = { source: 'mock', apiUrl: undefined, storage };
    const id = await createRepositories(config).deviceIdRepository.get();
    expect(id).toMatch(V4);
    expect(storage.data.get(KEY)).toBe(id);
    expect(await createRepositories(config).deviceIdRepository.get()).toBe(id);
  });
});

describe('forget (account deletion)', () => {
  it('removes the stored id and the id held in memory, so the next get makes a different one', async () => {
    const repo = open();
    const before = await repo.get();
    await repo.forget();
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    const after = await repo.get();
    expect(after).toMatch(SERVER_RULE);
    expect(after).not.toBe(before);
    expect(await AsyncStorage.getItem(KEY)).toBe(after);
  });

  it('never rejects, even when the store cannot be written', async () => {
    const repo = open();
    await repo.get();
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(new Error('disk full'));
    await expect(repo.forget()).resolves.toBeUndefined();
  });
});
