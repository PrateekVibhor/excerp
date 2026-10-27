import { useEffect, useSyncExternalStore } from 'react';
import { inboxStore as defaultStore } from '../../data';
import type { InboxSnapshot, InboxStore } from '../../data/inboxStore';
import type { ConversationView } from '../../data/socialApi';

const NOTHING: InboxSnapshot = { status: 'ready', inbox: null };
const none = { get: () => NOTHING, subscribe: () => () => {}, refresh: async () => {}, reset: () => {} } satisfies InboxStore;

/**
 * The shared copy of the reader's inbox, asked afresh whenever a screen that shows it opens (and kept current by the poll that runs
 * while the app is open). With no server (mock data) it is simply empty.
 */
export function useInboxSnapshot(store: InboxStore | null | undefined = defaultStore): InboxSnapshot {
  const source = store ?? none;
  const snapshot = useSyncExternalStore(source.subscribe, source.get, source.get);
  return snapshot;
}

export function useInbox(store: InboxStore | null | undefined = defaultStore) {
  const source = store ?? none;
  const snapshot = useInboxSnapshot(store);
  useEffect(() => {
    void source.refresh();
  }, [source]);
  const inbox = snapshot.inbox;
  // Newest first, whatever order they arrive in; equal times keep the order they came in.
  const newestFirst = (list: ConversationView[] | undefined) =>
    (list ?? []).map((c, i) => ({ c, i })).sort((a, b) => Date.parse(b.c.last_message_at) - Date.parse(a.c.last_message_at) || a.i - b.i).map(({ c }) => c);
  const lists: Record<'requests' | 'conversations' | 'sent', ConversationView[]> = { requests: newestFirst(inbox?.requests), conversations: newestFirst(inbox?.conversations), sent: newestFirst(inbox?.sent) };
  return { status: snapshot.status, ...lists, unread: inbox?.unread ?? 0, refresh: source.refresh };
}
