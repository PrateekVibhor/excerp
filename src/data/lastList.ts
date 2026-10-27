import type { KeyValueStorage } from './localStore';

/** Under the `swipy:` prefix, so the scoped storage keeps it for the signed-in account only. */
export const LAST_LIST_KEY = 'swipy:last_list';
const ID = /^[0-9a-zA-Z-]{1,64}$/;

/** Which list the reader had open last, so the Skills list tab opens it again. Only a plausible id is believed. */
export function createLastListStore(storage: KeyValueStorage) {
  return {
    async get(): Promise<string | null> {
      try {
        const raw = await storage.getItem(LAST_LIST_KEY);
        return raw !== null && ID.test(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    async set(id: string): Promise<void> {
      try {
        await storage.setItem(LAST_LIST_KEY, id);
      } catch {
        // not being able to remember is not a problem: the tab opens the most recent list
      }
    },
    async clear(): Promise<void> {
      try {
        await storage.removeItem?.(LAST_LIST_KEY);
      } catch {
        // as above
      }
    },
  };
}
export type LastListStore = ReturnType<typeof createLastListStore>;
