import AsyncStorage from '@react-native-async-storage/async-storage';
import { VERIFY_OUTBOX_KEY, type KeyValueStorage } from './localStore';
import type { LeaderboardApi } from './repository';

/** A verification waiting to be sent. The name and device id are added when it is sent, so a rename reaches the board. */
export interface QueuedVerification {
  article_id: string;
  verified_at: string;
}

export interface FlushResult {
  sent: number;
  /** Dropped because the server will never accept them. */
  rejected: number;
  /** Still waiting: the server could not take them yet. */
  remaining: number;
}

export interface SyncQueue {
  /**
   * Remembers a verification to send. Resolves once it is written to the device, without waiting for the network.
   * The same article is never queued twice. Never rejects.
   */
  enqueue(articleId: string, verifiedAt?: string): Promise<void>;
  /**
   * Sends what is waiting, oldest first, and stops at the first one the server cannot take now, so order is kept.
   * One send run at a time: asking again while one is running waits for it. Never rejects.
   */
  flush(): Promise<FlushResult>;
  /** Forgets everything waiting to be sent, on the device and in memory (account deletion). Never rejects. */
  clear(): Promise<void>;
  /**
   * Stops sending and waits for a send already under way to finish, so nothing can reach the server while the caller
   * works (account deletion). Verifications queued meanwhile wait. Resolves with a function that lets sending resume;
   * calling it twice is harmless. Never rejects.
   */
  hold(): Promise<() => void>;
}

export const FALLBACK_NAME = 'Reader';
const NAME_MAX = 40;

/** The name the board will show: the profile's, cleaned to what the server accepts, or "Reader". */
export function leaderboardName(profileName: string | null | undefined): string {
  const cleaned = (profileName ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  const name = [...cleaned].slice(0, NAME_MAX).join('').trim();
  return name === '' ? FALLBACK_NAME : name;
}

const isQueued = (v: unknown): v is QueuedVerification =>
  typeof v === 'object' && v !== null && typeof (v as QueuedVerification).article_id === 'string' && typeof (v as QueuedVerification).verified_at === 'string';

/**
 * The outbox of verifications for the leaderboard, kept under `swipy:verify_outbox`. A verification is saved on the
 * device first (Feature 8); this only carries it to the server later. The server counts a device and article once,
 * so sending something twice, for instance after the app closed between a send and its removal, is harmless.
 */
export function createSyncQueue({
  storage = AsyncStorage,
  api,
  getDeviceId,
  getDisplayName,
  now = () => new Date(),
}: {
  storage?: KeyValueStorage;
  api: LeaderboardApi;
  getDeviceId: () => Promise<string>;
  getDisplayName: () => Promise<string | null | undefined>;
  now?: () => Date;
}): SyncQueue {
  // All changes to the outbox go through this chain, so overlapping calls cannot overwrite each other's read-modify-write.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
  // Items that could not be written because the store could not be read. They are sent from here, and saved once it can be.
  let unsaved: QueuedVerification[] = [];
  let flushing: Promise<FlushResult> | undefined;
  let holds = 0;

  /** The saved outbox; null when the store cannot be read at all (nothing may be written then). */
  async function load(): Promise<QueuedVerification[] | null> {
    let raw: string | null;
    try {
      raw = await storage.getItem(VERIFY_OUTBOX_KEY);
    } catch {
      return null;
    }
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isQueued) : []; // damaged entries cannot be sent
    } catch {
      return []; // not JSON: nothing in it can be recovered
    }
  }

  const save = async (items: QueuedVerification[]) => {
    try {
      await storage.setItem(VERIFY_OUTBOX_KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  };

  /** The outbox as it stands, including anything held back while the store was unreadable. */
  async function current(): Promise<{ items: QueuedVerification[]; writable: boolean }> {
    const saved = await load();
    if (saved === null) return { items: unsaved, writable: false };
    if (unsaved.length === 0) return { items: saved, writable: true };
    const merged = [...saved, ...unsaved.filter((u) => !saved.some((s) => s.article_id === u.article_id))];
    if (await save(merged)) unsaved = [];
    return { items: merged, writable: true };
  }

  async function removeSent(articleId: string) {
    await serialized(async () => {
      const { items, writable } = await current();
      const rest = items.filter((i) => i.article_id !== articleId);
      if (writable) await save(rest);
      else unsaved = rest;
    });
  }

  async function run(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, rejected: 0, remaining: 0 };
    // Articles dealt with in this run. If taking one out of the saved outbox fails it stays saved (and is simply sent
    // again next time), but this run must not send it again and again.
    const done = new Set<string>();
    // The outbox is read again after every send, so a verification queued meanwhile is not left behind.
    for (;;) {
      const { items } = await serialized(current);
      const waiting = items.filter((i) => !done.has(i.article_id));
      const head = waiting[0];
      if (!head) return result;
      if (holds > 0) {
        result.remaining = waiting.length; // held: nothing is sent, and everything is still waiting
        return result;
      }
      let outcome: Awaited<ReturnType<LeaderboardApi['postVerification']>> = 'retry';
      try {
        const [device_id, name] = await Promise.all([getDeviceId(), getDisplayName().catch(() => null)]);
        outcome = await api.postVerification({ device_id, display_name: leaderboardName(name), article_id: head.article_id, verified_at: head.verified_at });
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'retry') {
        result.remaining = waiting.length;
        return result;
      }
      done.add(head.article_id);
      await removeSent(head.article_id);
      if (outcome === 'sent') result.sent++;
      else result.rejected++;
    }
  }

  return {
    async enqueue(articleId, verifiedAt = now().toISOString()) {
      await serialized(async () => {
        const { items, writable } = await current();
        if (items.some((i) => i.article_id === articleId)) return;
        const entry = { article_id: articleId, verified_at: verifiedAt };
        if (writable && (await save([...items, entry]))) return;
        // Not saved (the store could not be read or written): keep it for this run and save it when the store allows.
        unsaved = [...unsaved, entry];
      }).catch(() => undefined);
    },

    async clear() {
      await serialized(async () => {
        unsaved = [];
        try {
          await storage.removeItem?.(VERIFY_OUTBOX_KEY);
        } catch {
          // nothing more can be done; what is left is only sent under the id the app no longer has
        }
      }).catch(() => {});
    },

    async hold() {
      holds++;
      await flushing; // never rejects: flush() turns a failed run into a result
      let released = false;
      return () => {
        if (!released) holds--;
        released = true;
      };
    },

    flush() {
      flushing ??= run()
        .catch((): FlushResult => ({ sent: 0, rejected: 0, remaining: 0 }))
        .finally(() => {
          flushing = undefined;
        });
      return flushing;
    },
  };
}
