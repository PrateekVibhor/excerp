import { useEffect } from 'react';
import { AppState } from 'react-native';
import { accountSync as defaultSync, inboxStore as defaultInbox, listsStore as defaultLists, setRefusedHandler } from '../../data';
import type { AccountSync as Engine } from '../../data/accountSync';
import type { InboxStore } from '../../data/inboxStore';
import type { ListsStore } from '../../data/listsStore';
import { useAuth } from './useAuth';

/**
 * Keeps the signed-in account in step with the server while the app is open. Renders nothing. It starts when the reader is
 * approved on an account and stops when they leave it; it catches up whenever the app comes back to the front. If the
 * server says the session is gone or the account is not approved any more, the sign-in layer is told, as for any request.
 * It also keeps the inbox and the reader's skills lists current (when the app starts, comes to the front, and every 90 seconds): polling, not push, in this version.
 */
/** How often the inbox is asked about while the app is open. */
export const INBOX_POLL_MS = 90_000;

export function AccountSync({ sync = defaultSync, inbox = defaultInbox, lists = defaultLists, pollMs = INBOX_POLL_MS }: { sync?: Engine; inbox?: InboxStore | null; lists?: ListsStore | null; pollMs?: number }) {
  const auth = useAuth();
  const refused = auth?.refused;
  const active = auth?.state.kind === 'approved' && auth.accountRef !== null;
  const ref = auth?.accountRef ?? null;

  useEffect(() => {
    setRefusedHandler(refused ? (status) => void refused(status) : undefined);
    return () => setRefusedHandler(undefined);
  }, [refused]);

  useEffect(() => {
    if (!active) return;
    void sync.start();
    void inbox?.refresh();
    void lists?.refresh();
    const poll = inbox || lists ? setInterval(() => { void inbox?.refresh(); void lists?.refresh(); }, pollMs) : undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void sync.syncNow();
      void sync.flushSkips();
      void inbox?.refresh();
      void lists?.refresh();
    });
    return () => {
      subscription.remove();
      if (poll) clearInterval(poll);
      sync.stop();
      inbox?.reset(); // another reader's inbox must never be shown to the next
      lists?.reset(); // nor their lists
    };
    // a different account is a fresh start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref, sync, inbox, lists, pollMs]);

  return null;
}
