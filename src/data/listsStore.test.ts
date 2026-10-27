jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

import type { CourseApi, MyList } from './courseApi';
import { createLastListStore, LAST_LIST_KEY } from './lastList';
import { createListsStore, hasNewCoverage } from './listsStore';
import { createScopedStorage } from './scopedStorage';

const list = (id: string, over: Partial<MyList> = {}): MyList => ({
  id, role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: null, industryLabel: null, customTitle: null,
  createdAt: '2026-10-19T09:00:00.000Z', lastActiveAt: '2026-10-19T10:00:00.000Z', checkedAt: null, refreshing: false, coverage: null, hasUpdates: false, ...over,
});
const api = (mine: jest.Mock): Pick<CourseApi, 'mine'> => ({ mine });
const ok = (value: MyList[]) => ({ kind: 'ok' as const, value });

describe('the lists store', () => {
  it('starts idle, loads the reader\'s lists (list courses only) and tells the listeners', async () => {
    const store = createListsStore(api(jest.fn(async () => ok([list('a'), list('n', { mode: 'narrow' }), list('b')]))));
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().status));
    expect(store.get()).toEqual({ status: 'idle', lists: [] });
    await store.refresh();
    expect(store.get().status).toBe('ready');
    expect(store.get().lists.map((l) => l.id)).toEqual(['a', 'b']);
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('asking while a request is under way gets that one', async () => {
    const mine = jest.fn(async () => ok([list('a')]));
    const store = createListsStore(api(mine));
    await Promise.all([store.refresh(), store.refresh()]);
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it('a failed request keeps what the reader had, and with nothing says unavailable', async () => {
    const mine = jest.fn().mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce(ok([list('a')])).mockResolvedValueOnce({ kind: 'failed' });
    const store = createListsStore(api(mine));
    await store.refresh();
    expect(store.get()).toEqual({ status: 'unavailable', lists: [] });
    await store.refresh();
    await store.refresh();
    expect(store.get().status).toBe('ready');
    expect(store.get().lists.map((l) => l.id)).toEqual(['a']);
  });

  it('a session that is gone is reported, as the inbox does', async () => {
    const refused = jest.fn();
    const store = createListsStore(api(jest.fn(async () => ({ kind: 'unauthorized' as const }))), refused);
    await store.refresh();
    expect(refused).toHaveBeenCalledWith(401);
    const forbidden = jest.fn();
    await createListsStore(api(jest.fn(async () => ({ kind: 'refused' as const, status: 403, code: '' }))), forbidden).refresh();
    expect(forbidden).toHaveBeenCalledWith(403);
  });

  it('a change to one list (a new name, a check under way) or its removal shows at once, without asking the server', async () => {
    const store = createListsStore(api(jest.fn(async () => ok([list('a'), list('b')]))));
    await store.refresh();
    const before = store.get().lists;
    store.patch('a', { customTitle: 'Mine' });
    expect(store.get().lists.map((l) => l.customTitle)).toEqual(['Mine', null]);
    expect(store.get().lists).not.toBe(before);
    store.drop('b');
    expect(store.get().lists.map((l) => l.id)).toEqual(['a']);
    store.touch('a', '2026-10-20T08:00:00.000Z');
    expect(store.get().lists[0]!.lastActiveAt).toBe('2026-10-20T08:00:00.000Z');
  });

  it('touching a list moves it to the top', async () => {
    const store = createListsStore(api(jest.fn(async () => ok([list('a'), list('b'), list('c')]))));
    await store.refresh();
    store.touch('c', '2026-10-21T08:00:00.000Z');
    expect(store.get().lists.map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('reset forgets everything, and an answer to a request from before it is ignored', async () => {
    let release!: (v: unknown) => void;
    const mine = jest.fn(() => new Promise((r) => { release = r; }));
    const store = createListsStore(api(mine as unknown as jest.Mock));
    const pending = store.refresh();
    store.reset();
    release(ok([list('a')]));
    await pending;
    expect(store.get()).toEqual({ status: 'idle', lists: [] });
  });

  it('there is new coverage to see when any list says so', () => {
    expect(hasNewCoverage({ status: 'ready', lists: [list('a'), list('b', { hasUpdates: true })] })).toBe(true);
    expect(hasNewCoverage({ status: 'ready', lists: [list('a')] })).toBe(false);
    expect(hasNewCoverage({ status: 'idle', lists: [] })).toBe(false);
  });
});

describe('the last list the reader opened', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { data, getItem: async (k: string) => data.get(k) ?? null, setItem: async (k: string, v: string) => void data.set(k, v), removeItem: async (k: string) => void data.delete(k) };
  };
  it('is remembered, and forgotten on request', async () => {
    const store = createLastListStore(memory());
    expect(await store.get()).toBeNull();
    await store.set('c1');
    expect(await store.get()).toBe('c1');
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('belongs to the account that is signed in: another account on the phone has its own', async () => {
    const base = memory();
    const scoped = createScopedStorage(base);
    const store = createLastListStore(scoped);
    scoped.setScope('EXC-0H6P-V20G');
    await store.set('mine');
    scoped.setScope('EXC-2222-3333');
    expect(await store.get()).toBeNull();
    await store.set('theirs');
    scoped.setScope('EXC-0H6P-V20G');
    expect(await store.get()).toBe('mine');
    expect([...base.data.keys()].every((k) => k.includes(':acct:'))).toBe(true);
    expect(LAST_LIST_KEY.startsWith('swipy:')).toBe(true);
  });

  it('something that is not an id is not remembered', async () => {
    const base = memory();
    base.data.set(LAST_LIST_KEY, JSON.stringify({ not: 'an id' }));
    expect(await createLastListStore(base).get()).toBeNull();
    base.data.set(LAST_LIST_KEY, 'x'.repeat(200));
    expect(await createLastListStore(base).get()).toBeNull();
  });
});
