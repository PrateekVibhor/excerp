import type { CourseApi, MyList } from './courseApi';

export interface ListsSnapshot {
  /** idle: not asked yet; loading: the first answer is awaited; ready: there are lists (maybe none); unavailable: they could not be had and there are none to show. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  lists: MyList[];
}

/** One shared copy of the reader's lists, so the tab dot, the list panel and the open list all agree. */
export interface ListsStore {
  get(): ListsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Asks the server. One at a time: asking while one is under way gets that one. Never rejects. */
  refresh(): Promise<void>;
  /** A change the reader just made to one list shows at once; the next refresh confirms it. */
  patch(id: string, change: Partial<MyList>): void;
  /** Counts a list as used at `at` (an ISO time) and puts it first. */
  touch(id: string, at: string): void;
  /** A list the reader removed. */
  drop(id: string): void;
  /** Forgets everything: another reader is now signed in. */
  reset(): void;
}

export const hasNewCoverage = (s: ListsSnapshot): boolean => s.lists.some((l) => l.hasUpdates);

export function createListsStore(api: Pick<CourseApi, 'mine'>, onRefused?: (status: 401 | 403) => void): ListsStore {
  let snapshot: ListsSnapshot = { status: 'idle', lists: [] };
  const listeners = new Set<() => void>();
  let running: Promise<void> | undefined;
  let generation = 0;
  const set = (next: ListsSnapshot) => {
    snapshot = next;
    listeners.forEach((l) => l());
  };
  const setLists = (lists: MyList[]) => set({ status: 'ready', lists });

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (running) return running;
      const mine = generation;
      if (snapshot.status === 'idle') set({ status: 'loading', lists: [] });
      running = (async () => {
        try {
          const res = await api.mine();
          if (mine !== generation) return; // another reader signed in meanwhile: this answer is not theirs
          if (res.kind === 'ok') return setLists(res.value.filter((l) => l.mode === 'list'));
          if (res.kind === 'unauthorized') onRefused?.(401);
          else if (res.kind === 'refused' && res.status === 403) onRefused?.(403);
          // Whatever we had stays; with nothing, it is simply not available.
          if (snapshot.status !== 'ready') set({ status: 'unavailable', lists: [] });
        } catch {
          if (mine === generation && snapshot.status !== 'ready') set({ status: 'unavailable', lists: [] });
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
    patch: (id, change) => setLists(snapshot.lists.map((l) => (l.id === id ? { ...l, ...change } : l))),
    touch(id, at) {
      const found = snapshot.lists.find((l) => l.id === id);
      if (found) setLists([{ ...found, lastActiveAt: at }, ...snapshot.lists.filter((l) => l.id !== id)]);
    },
    drop: (id) => setLists(snapshot.lists.filter((l) => l.id !== id)),
    reset() {
      generation++;
      running = undefined;
      set({ status: 'idle', lists: [] });
    },
  };
}
