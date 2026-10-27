import type { Inbox, SocialApi } from './socialApi';

export interface InboxSnapshot {
  /** idle: not asked yet; loading: the first answer is awaited; ready: there is an inbox; unavailable: it could not be had and there is none to show. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  inbox: Inbox | null;
}

/** One shared copy of the reader's inbox, so the badge, the inbox and a conversation all agree. */
export interface InboxStore {
  get(): InboxSnapshot;
  subscribe(listener: () => void): () => void;
  /** Asks the server. One at a time: asking while one is under way gets that one. Never rejects. */
  refresh(): Promise<void>;
  /** Forgets everything: another reader is now signed in. */
  reset(): void;
}

export function createInboxStore(api: Pick<SocialApi, 'inbox'>, onRefused?: (status: 401 | 403) => void): InboxStore {
  let snapshot: InboxSnapshot = { status: 'idle', inbox: null };
  const listeners = new Set<() => void>();
  let running: Promise<void> | undefined;
  let generation = 0;
  const set = (next: InboxSnapshot) => {
    snapshot = next;
    listeners.forEach((l) => l());
  };

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
      if (snapshot.status === 'idle') set({ status: 'loading', inbox: null });
      running = (async () => {
        try {
          const res = await api.inbox();
          if (mine !== generation) return; // another reader signed in meanwhile: this answer is not theirs
          if (res.kind === 'ok') return set({ status: 'ready', inbox: res.value });
          if (res.kind === 'unauthorized') onRefused?.(401);
          else if (res.kind === 'refused' && res.status === 403) onRefused?.(403);
          // Whatever we had stays; with nothing, it is simply not available.
          if (snapshot.inbox === null) set({ status: 'unavailable', inbox: null });
        } catch {
          if (mine === generation && snapshot.inbox === null) set({ status: 'unavailable', inbox: null });
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
    reset() {
      generation++;
      running = undefined;
      set({ status: 'idle', inbox: null });
    },
  };
}
