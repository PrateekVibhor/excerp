import { useSyncExternalStore } from 'react';
import { listsStore as defaultStore } from '../../data';
import type { ListsSnapshot, ListsStore } from '../../data/listsStore';

const NOTHING: ListsSnapshot = { status: 'ready', lists: [] };
const none = { get: () => NOTHING, subscribe: () => () => {}, refresh: async () => {}, patch: () => {}, touch: () => {}, drop: () => {}, reset: () => {} } satisfies ListsStore;

/** The shared copy of the reader's lists. With no server (mock data) it is simply empty. */
export function useListsSnapshot(store: ListsStore | null | undefined = defaultStore): ListsSnapshot {
  const source = store ?? none;
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}
