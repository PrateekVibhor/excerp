import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLocalStore } from './localStore';
import { INTERESTS } from './types';
import { createVerifiedRepository, OTHER_TOPIC, topicFor } from './verifiedRepository';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const KEY = 'swipy:verified';
const NOW = new Date('2026-10-06T09:30:00.000Z');
// A new repository over the same storage stands in for an app restart.
const open = (now = () => NOW) => createVerifiedRepository(AsyncStorage, now);
const stored = async () => JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null');

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('verified repository', () => {
  it('starts empty', async () => {
    const repo = open();
    expect(await repo.list()).toEqual([]);
    expect(await repo.isVerified('a')).toBe(false);
    expect(await AsyncStorage.getItem(KEY)).toBeNull(); // reading writes nothing
  });

  it('adds a record with the article, the time and the topic, and reports it as verified', async () => {
    const repo = open();
    const result = await repo.add('a', 'Agents');
    expect(result).toEqual({ added: true, record: { article_id: 'a', verified_at: '2026-10-06T09:30:00.000Z', topic: 'Agents' } });
    expect(await repo.isVerified('a')).toBe(true);
    expect(await repo.isVerified('b')).toBe(false);
    expect(await repo.list()).toEqual([result.record]);
    expect(await stored()).toEqual([result.record]); // under swipy:verified, as a list
  });

  it('keeps records oldest first', async () => {
    let t = 0;
    const repo = open(() => new Date(NOW.getTime() + 1000 * t++));
    await repo.add('a', 'Cloud');
    await repo.add('b', 'Safety');
    await repo.add('c', null);
    expect((await repo.list()).map((r) => r.article_id)).toEqual(['a', 'b', 'c']);
  });

  it('Scenario: Verify once - passing the quiz again stores no second record and keeps the first', async () => {
    let t = 0;
    const repo = open(() => new Date(NOW.getTime() + 60_000 * t++));
    const first = await repo.add('a', 'Agents');
    const again = await repo.add('a', 'Cloud'); // later, and with another topic
    expect(again).toEqual({ added: false, record: first.record });
    expect(await repo.list()).toHaveLength(1);
    expect((await repo.list())[0].verified_at).toBe('2026-10-06T09:30:00.000Z');
    expect((await repo.list())[0].topic).toBe('Agents');
  });

  it('a second pass writes nothing and tells nobody', async () => {
    const repo = open();
    await repo.add('a', 'Agents');
    const listener = jest.fn();
    repo.subscribe(listener);
    const setItem = AsyncStorage.setItem as jest.Mock;
    setItem.mockClear(); // the storage mock keeps calls from earlier tests
    await repo.add('a', 'Agents');
    expect(setItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('Scenario: Persistence - after a restart the badge is still there', async () => {
    await open().add('a', 'Agents');
    await open().add('b', 'Cloud');
    const restarted = open();
    expect(await restarted.isVerified('a')).toBe(true);
    expect(await restarted.isVerified('b')).toBe(true);
    expect((await restarted.list()).map((r) => r.article_id)).toEqual(['a', 'b']);
  });

  it('stores a topic from the interest list as it is, and anything else as "Other"', async () => {
    const repo = open();
    for (const [i, topic] of INTERESTS.entries()) expect((await repo.add(`t${i}`, topic)).record.topic).toBe(topic);
    for (const [i, topic] of [null, undefined, '', 'Cooking', 'agents', 'Other'].entries()) {
      expect((await repo.add(`o${i}`, topic)).record.topic).toBe(OTHER_TOPIC);
    }
    expect(topicFor('Cloud')).toBe('Cloud');
    expect(topicFor(null)).toBe('Other');
  });

  it('two adds at the same moment both land, and the same article twice at once lands once', async () => {
    const repo = open();
    await Promise.all([repo.add('a', 'Cloud'), repo.add('b', 'Agents')]);
    expect((await repo.list()).map((r) => r.article_id).sort()).toEqual(['a', 'b']);
    const results = await Promise.all([repo.add('c', 'Cloud'), repo.add('c', 'Cloud'), repo.add('c', 'Cloud')]);
    expect(results.map((r) => r.added)).toEqual([true, false, false]);
    expect((await repo.list()).filter((r) => r.article_id === 'c')).toHaveLength(1);
  });

  it('Scenario: Badge survives removal - taking the article off the Reading List keeps the record', async () => {
    const store = createLocalStore(AsyncStorage);
    const repo = open();
    await store.add('user', 'a');
    await repo.add('a', 'Agents');
    await store.remove('user', 'a');
    expect(await store.list('user')).toEqual([]);
    expect(await repo.isVerified('a')).toBe(true);
    expect(await repo.list()).toHaveLength(1);
    await store.add('user', 'a'); // saved again later: still verified
    expect(await open().isVerified('a')).toBe(true);
  });

  it('keeps a record whose article the API no longer returns, and offers no way to remove one', async () => {
    const repo = open();
    await repo.add('gone-from-the-api', 'Cloud');
    expect(await repo.isVerified('gone-from-the-api')).toBe(true);
    expect(Object.keys(repo).sort()).toEqual(['add', 'isVerified', 'list', 'mergeRemote', 'subscribe']); // mergeRemote only ever adds, or moves a time earlier
  });

  it('tells subscribers when a record is added, until they unsubscribe', async () => {
    const repo = open();
    const listener = jest.fn();
    const off = repo.subscribe(listener);
    await repo.add('a', 'Cloud');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await repo.add('b', 'Cloud');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('verified repository: when the store cannot be read', () => {
  it('Scenario: reading fails - no badges, no crash', async () => {
    const failing = createVerifiedRepository({ getItem: async () => { throw new Error('disk error'); }, setItem: async () => {} });
    await expect(failing.list()).resolves.toEqual([]);
    await expect(failing.isVerified('a')).resolves.toBe(false);
  });

  it.each([['not json {', 'broken text'], ['{"a":1}', 'an object'], ['"text"', 'a string'], ['7', 'a number'], ['null', 'null']])(
    'stored %s (%s): no badges, no crash, and nothing is written over it',
    async (raw) => {
      await AsyncStorage.setItem(KEY, raw);
      const repo = open();
      await expect(repo.list()).resolves.toEqual([]);
      await expect(repo.isVerified('a')).resolves.toBe(false);
      await expect(repo.add('a', 'Cloud')).rejects.toBeDefined();
      expect(await AsyncStorage.getItem(KEY)).toBe(raw); // untouched
      await expect(repo.isVerified('a')).resolves.toBe(false); // and the repository still works afterwards
    },
  );

  it('a failed write is an error and records nothing; the next add works', async () => {
    let failNext = true;
    const flaky = {
      getItem: (k: string) => AsyncStorage.getItem(k),
      setItem: async (k: string, v: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('storage full');
        }
        return AsyncStorage.setItem(k, v);
      },
    };
    const repo = createVerifiedRepository(flaky, () => NOW);
    const listener = jest.fn();
    repo.subscribe(listener);
    await expect(repo.add('a', 'Cloud')).rejects.toThrow('storage full');
    expect(await repo.isVerified('a')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect((await repo.add('a', 'Cloud')).added).toBe(true);
    expect(await repo.isVerified('a')).toBe(true);
  });

  it('records that are damaged are left out of the list but kept in storage when a new one is added', async () => {
    const good = { article_id: 'ok', verified_at: '2026-10-01T00:00:00.000Z', topic: 'Cloud' };
    const damaged = [{ article_id: 5 }, 'junk', null, { article_id: 'x', verified_at: 1, topic: 'Cloud' }];
    await AsyncStorage.setItem(KEY, JSON.stringify([...damaged, good]));
    const repo = open();
    expect(await repo.list()).toEqual([good]);
    expect(await repo.isVerified('x')).toBe(false);
    await repo.add('new', 'Agents');
    expect((await stored()).slice(0, 5)).toEqual([...damaged, good]); // nothing it could not use was thrown away
    expect((await repo.list()).map((r) => r.article_id)).toEqual(['ok', 'new']);
  });

  it('a read that fails once does not stop later reads', async () => {
    let fail = true;
    const repo = createVerifiedRepository({
      getItem: async (k) => {
        if (fail) throw new Error('boom');
        return AsyncStorage.getItem(k);
      },
      setItem: (k, v) => AsyncStorage.setItem(k, v),
    }, () => NOW);
    await expect(repo.isVerified('a')).resolves.toBe(false);
    fail = false;
    await repo.add('a', 'Cloud');
    await expect(repo.isVerified('a')).resolves.toBe(true);
  });
});

describe('verified repository: no network', () => {
  it('makes no request', async () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    try {
      const repo = open();
      await repo.add('a', 'Cloud');
      await repo.list();
      await repo.isVerified('a');
    } finally {
      global.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mergeRemote (records from another phone of the same account)', () => {
  const rec = (article_id: string, verified_at: string, topic = 'Cloud') => ({ article_id, verified_at, topic });
  it('adds what is new, keeps the earlier time for one it has, ignores a later one, and calls the listeners once', async () => {
    const repo = createVerifiedRepository(AsyncStorage, () => new Date('2026-10-10T12:00:00.000Z'));
    await repo.add('a', 'Cloud');
    const listener = jest.fn();
    repo.subscribe(listener);
    const changed = await repo.mergeRemote([rec('a', '2026-10-09T00:00:00.000Z'), rec('b', '2026-10-08T00:00:00.000Z', 'Agents'), rec('a', '2026-10-11T00:00:00.000Z')]);
    expect(changed).toBe(2); // a got an earlier time, b is new
    expect(listener).toHaveBeenCalledTimes(1);
    const list = await repo.list();
    expect(list.map((r) => [r.article_id, r.verified_at, r.topic])).toEqual([['b', '2026-10-08T00:00:00.000Z', 'Agents'], ['a', '2026-10-09T00:00:00.000Z', 'Cloud']]);
    expect(await repo.mergeRemote([rec('a', '2026-10-09T00:00:00.000Z')])).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('never rejects, and never writes over a list it could not read', async () => {
    await AsyncStorage.setItem('swipy:verified', '{not json');
    const repo = createVerifiedRepository(AsyncStorage);
    expect(await repo.mergeRemote([rec('a', '2026-10-09T00:00:00.000Z')])).toBe(0);
    expect(await AsyncStorage.getItem('swipy:verified')).toBe('{not json');
  });
});
