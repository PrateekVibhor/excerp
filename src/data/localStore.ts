import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReadingListRepository } from './repository';
import type { Profile, ReadingListItem, SwipeEvent } from './types';

export const SWIPES_KEY = 'swipy:swipes';
export const SAVED_KEY = 'swipy:reading_list';
export const PROFILE_KEY = 'swipy:profile';
/** Passed quizzes. Read and written only by verifiedRepository. */
export const VERIFIED_KEY = 'swipy:verified';
/** The random id this device uses on the leaderboard. Read and written only by deviceIdRepository. */
export const DEVICE_ID_KEY = 'swipy:device_id';
/** Verifications not yet sent to the leaderboard server. Read and written only by the sync queue. */
export const VERIFY_OUTBOX_KEY = 'swipy:verify_outbox';

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  /** Optional so small stand-ins need not have it; the real AsyncStorage does. */
  removeItem?(key: string): Promise<unknown>;
  /** Optional so small stand-ins need not have it; the real AsyncStorage does. */
  getAllKeys?(): Promise<readonly string[]>;
}

export interface LocalStore extends ReadingListRepository {
  /** Ids of every article this user has swiped, in either direction. */
  getSwipedIds(userId: string): Promise<Set<string>>;
  /** The reader's own profile, or null before one is saved. One per device. */
  getProfile(): Promise<Profile | null>;
  /** Replaces the whole profile record, so only the new values remain. */
  saveProfile(profile: Profile): Promise<Profile>;
  /**
   * Adds a saved item with the time it was saved elsewhere (another phone of the same account). False, changing nothing,
   * when the article is already saved. Calls the reading-list listeners when it adds.
   */
  putSaved(userId: string, articleId: string, savedAt: string): Promise<boolean>;
  /** Ids of the articles swiped left (skipped), one entry per swipe, oldest first. */
  getSkippedIds(userId: string): Promise<string[]>;
  /** Calls the listener after the profile is saved. Returns an unsubscribe function. */
  subscribeToProfile(listener: () => void): () => void;
  /** Calls the listener after a saved item is added or removed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Swipes and saved items kept on the device. Only ids and timestamps are stored.
 * Writes are queued so overlapping calls (a swipe and a save together) cannot
 * overwrite each other's read-modify-write.
 */
export function createLocalStore(storage: KeyValueStorage = AsyncStorage): LocalStore {
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const profileListeners = new Set<() => void>();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function read<T>(key: string): Promise<T[]> {
    const raw = await storage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  }
  const write = (key: string, value: unknown) => storage.setItem(key, JSON.stringify(value));

  return {
    list: (userId) =>
      serialized(async () => {
        const saved = await read<ReadingListItem>(SAVED_KEY);
        // Stored in save order, so newest first is the reverse.
        return saved.filter((i) => i.user_id === userId).reverse();
      }),

    add: (userId, articleId) =>
      serialized(async () => {
        const saved = await read<ReadingListItem>(SAVED_KEY);
        const existing = saved.find((i) => i.user_id === userId && i.article_id === articleId);
        if (existing) return existing;
        const item: ReadingListItem = {
          id: `${userId}:${articleId}`,
          user_id: userId,
          article_id: articleId,
          saved_at: new Date().toISOString(),
        };
        await write(SAVED_KEY, [...saved, item]);
        notify();
        return item;
      }),

    remove: (userId, articleId) =>
      serialized(async () => {
        const saved = await read<ReadingListItem>(SAVED_KEY);
        const kept = saved.filter((i) => !(i.user_id === userId && i.article_id === articleId));
        if (kept.length === saved.length) return;
        await write(SAVED_KEY, kept);
        notify();
      }),

    putSaved: (userId, articleId, savedAt) =>
      serialized(async () => {
        const saved = await read<ReadingListItem>(SAVED_KEY);
        if (saved.some((i) => i.user_id === userId && i.article_id === articleId)) return false;
        const item: ReadingListItem = { id: `${userId}:${articleId}`, user_id: userId, article_id: articleId, saved_at: savedAt };
        // Kept in the order they were saved, wherever that was, so "newest first" stays true.
        const next = [...saved, item].sort((a, b) => Date.parse(a.saved_at) - Date.parse(b.saved_at));
        await write(SAVED_KEY, next);
        notify();
        return true;
      }),

    getSkippedIds: (userId) =>
      serialized(async () => (await read<SwipeEvent>(SWIPES_KEY)).filter((s) => s.user_id === userId && s.direction === 'left').map((s) => s.article_id)),

    subscribeToProfile: (listener) => {
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
      };
    },

    recordSwipe: (event: SwipeEvent) =>
      serialized(async () => {
        const swipes = await read<SwipeEvent>(SWIPES_KEY);
        await write(SWIPES_KEY, [...swipes, event]);
      }),

    getProfile: () =>
      serialized(async () => {
        const raw = await storage.getItem(PROFILE_KEY);
        return raw ? (JSON.parse(raw) as Profile) : null;
      }),

    saveProfile: (profile) =>
      serialized(async () => {
        await write(PROFILE_KEY, profile);
        profileListeners.forEach((listener) => listener());
        return profile;
      }),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSwipedIds: (userId) =>
      serialized(async () => {
        const swipes = await read<SwipeEvent>(SWIPES_KEY);
        return new Set(swipes.filter((s) => s.user_id === userId).map((s) => s.article_id));
      }),
  };
}
