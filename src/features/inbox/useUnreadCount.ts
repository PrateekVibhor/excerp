import type { InboxStore } from '../../data/inboxStore';
import { useInboxSnapshot } from './useInbox';

/** Number of unread messages, kept current by the inbox poll. 0 while it is not known, or with no server. */
export function useUnreadCount(store?: InboxStore | null): number {
  return useInboxSnapshot(store).inbox?.unread ?? 0;
}
