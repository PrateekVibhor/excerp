import { act, create } from 'react-test-renderer';
import type { MyList } from '../../data/courseApi';
import type { ListsSnapshot, ListsStore } from '../../data/listsStore';
import { useListsSnapshot } from './useLists';
import { useNewCoverage } from './useNewCoverage';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ listsStore: null }));

const list = (hasUpdates: boolean): MyList => ({ id: 'a', role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: null, industryLabel: null, customTitle: null, createdAt: 'x', lastActiveAt: 'x', checkedAt: null, refreshing: false, coverage: null, hasUpdates });
function fakeStore(initial: ListsSnapshot) {
  let snap = initial;
  const listeners = new Set<() => void>();
  return Object.assign({ get: () => snap, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), refresh: jest.fn(async () => {}), patch: jest.fn(), touch: jest.fn(), drop: jest.fn(), reset: jest.fn() } satisfies ListsStore, { set: (s: ListsSnapshot) => { snap = s; listeners.forEach((l) => l()); } });
}
function probe<T>(hook: () => T) {
  const seen: T[] = [];
  const Probe = () => { seen.push(hook()); return null; };
  act(() => { create(<Probe />); });
  return seen;
}

describe('useNewCoverage', () => {
  it('is true when any list has new coverage, and follows the store', () => {
    const store = fakeStore({ status: 'ready', lists: [list(false)] });
    const seen = probe(() => useNewCoverage(store));
    expect(seen.at(-1)).toBe(false);
    act(() => store.set({ status: 'ready', lists: [list(false), list(true)] }));
    expect(seen.at(-1)).toBe(true);
  });

  it('is false with no server (mock data)', () => {
    expect(probe(() => useNewCoverage(null)).at(-1)).toBe(false);
  });
});

describe('useListsSnapshot', () => {
  it('gives the store\'s lists, and an empty ready answer with no store', () => {
    expect(probe(() => useListsSnapshot(null)).at(-1)).toEqual({ status: 'ready', lists: [] });
    const store = fakeStore({ status: 'ready', lists: [list(false)] });
    expect(probe(() => useListsSnapshot(store)).at(-1)!.lists).toHaveLength(1);
  });
});
