import AsyncStorage from '@react-native-async-storage/async-storage';
import { VERIFIED_KEY, type KeyValueStorage } from './localStore';
import { INTERESTS, OTHER_TOPIC, type VerifiedRecord } from './types';

export { OTHER_TOPIC };

export interface VerifiedRepository {
  /** Every verified record, oldest first. Empty when the store cannot be read: no badges, no crash. */
  list(): Promise<VerifiedRecord[]>;
  /** False when the article is not verified, and also when the store cannot be read. */
  isVerified(articleId: string): Promise<boolean>;
  /**
   * Records that the reader passed this article's quiz. Once per article: a second call changes nothing
   * and returns the first record with `added: false`. Rejects, writing nothing, when the stored data
   * cannot be read, so older records are never written over.
   */
  add(articleId: string, topic?: string | null): Promise<{ record: VerifiedRecord; added: boolean }>;
  /** Calls the listener after a record is added. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Takes in records made on another phone of the same account: a new article is added, and for one already here the
   * earlier time wins. Calls the listeners once if anything changed. Resolves how many records changed. Never rejects.
   */
  mergeRemote(records: VerifiedRecord[]): Promise<number>;
}

const isRecord = (v: unknown): v is VerifiedRecord =>
  typeof v === 'object' && v !== null && typeof (v as VerifiedRecord).article_id === 'string' && typeof (v as VerifiedRecord).verified_at === 'string' && typeof (v as VerifiedRecord).topic === 'string';

/** A topic from the interest list, or "Other" for anything else. */
export const topicFor = (topic: string | null | undefined): string => INTERESTS.find((t) => t === topic) ?? OTHER_TOPIC;

/**
 * Verified articles kept on the device, under `swipy:verified`. There is deliberately no way to remove a
 * record: taking an article off the Reading List, or the API no longer returning it, does not unverify it.
 * Writes are queued so two overlapping adds cannot overwrite each other.
 */
export function createVerifiedRepository(storage: KeyValueStorage = AsyncStorage, now: () => Date = () => new Date()): VerifiedRepository {
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /** The stored list as it is, junk entries included. Throws when there is none that can be trusted. */
  async function readAll(): Promise<unknown[]> {
    const raw = await storage.getItem(VERIFIED_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Stored ${VERIFIED_KEY} is not a list`);
    return parsed;
  }
  const readRecords = async () => (await readAll()).filter(isRecord);

  return {
    list: () => serialized(readRecords).catch(() => []),

    isVerified: (articleId) =>
      serialized(readRecords).then(
        (records) => records.some((r) => r.article_id === articleId),
        () => false,
      ),

    add: (articleId, topic) =>
      serialized(async () => {
        const stored = await readAll();
        const existing = stored.filter(isRecord).find((r) => r.article_id === articleId);
        if (existing) return { record: existing, added: false };
        const record: VerifiedRecord = { article_id: articleId, verified_at: now().toISOString(), topic: topicFor(topic) };
        await storage.setItem(VERIFIED_KEY, JSON.stringify([...stored, record])); // entries it could not use are kept as they were
        listeners.forEach((listener) => listener());
        return { record, added: true };
      }),

    mergeRemote: (incoming) =>
      serialized(async () => {
        const stored = await readAll();
        const records = new Map(stored.filter(isRecord).map((r) => [r.article_id, r]));
        let changed = 0;
        for (const r of incoming) {
          if (!isRecord(r)) continue;
          const mine = records.get(r.article_id);
          if (mine && Date.parse(mine.verified_at) <= Date.parse(r.verified_at)) continue;
          records.set(r.article_id, { article_id: r.article_id, verified_at: r.verified_at, topic: topicFor(r.topic) });
          changed++;
        }
        if (changed === 0) return 0;
        const kept = stored.filter((e) => !isRecord(e)); // entries it could not use are kept as they were
        await storage.setItem(VERIFIED_KEY, JSON.stringify([...kept, ...[...records.values()].sort((a, b) => Date.parse(a.verified_at) - Date.parse(b.verified_at))]));
        listeners.forEach((listener) => listener());
        return changed;
      }).catch(() => 0),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
