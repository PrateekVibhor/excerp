import { act, create } from 'react-test-renderer';
import { createInboxStore } from '../../data/inboxStore';
import { emptyInbox, ok } from '../readers/testing';
import { useUnreadCount } from './useUnreadCount';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ inboxStore: null }));

function probe(store: ReturnType<typeof createInboxStore> | null) {
  const seen: number[] = [];
  function P() { seen.push(useUnreadCount(store)); return null; }
  return { seen, render: () => act(async () => { create(<P />); }) };
}

describe('useUnreadCount', () => {
  it('is 0 until the inbox is known, then the number the server gave, and follows changes', async () => {
    const answers = [ok(emptyInbox({ unread: 3 })), ok(emptyInbox({ unread: 0 }))];
    const store = createInboxStore({ inbox: jest.fn(async () => answers.shift()!) });
    const p = probe(store);
    await p.render();
    expect(p.seen[p.seen.length - 1]).toBe(0);
    await act(async () => { await store.refresh(); });
    expect(p.seen[p.seen.length - 1]).toBe(3);
    await act(async () => { await store.refresh(); });
    expect(p.seen[p.seen.length - 1]).toBe(0);
  });
  it('is 0 with no server (mock data) or after the reader is gone', async () => {
    const none = probe(null);
    await none.render();
    expect(none.seen[none.seen.length - 1]).toBe(0);
    const store = createInboxStore({ inbox: jest.fn(async () => ok(emptyInbox({ unread: 4 }))) });
    await store.refresh();
    const p = probe(store);
    await p.render();
    expect(p.seen[p.seen.length - 1]).toBe(4);
    await act(async () => store.reset());
    expect(p.seen[p.seen.length - 1]).toBe(0);
  });
});
