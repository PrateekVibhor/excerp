import { act, create } from 'react-test-renderer';
import { createInboxStore } from '../../data/inboxStore';
import { conversation, emptyInbox, ok } from '../readers/testing';
import { useInbox } from './useInbox';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ inboxStore: null }));

function probe(store: ReturnType<typeof createInboxStore> | null) {
  const seen: Array<ReturnType<typeof useInbox>> = [];
  function P() { seen.push(useInbox(store)); return null; }
  return { seen, last: () => seen[seen.length - 1], render: () => act(async () => { create(<P />); }) };
}

describe('useInbox', () => {
  it('asks the server when a screen opens, is not ready until the server has answered, then the three lists and the unread count', async () => {
    const inbox = emptyInbox({ unread: 2, requests: [conversation(1, { state: 'request', unread: 1 })], conversations: [conversation(2, { unread: 1 })], sent: [conversation(3, { role: 'initiator', state: 'pending' })] });
    const api = { inbox: jest.fn(async () => ok(inbox)) };
    const store = createInboxStore(api);
    const p = probe(store);
    await p.render();
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(['idle', 'loading']).toContain(p.seen[0].status); // not ready until the server has answered
    expect(p.last()).toMatchObject({ status: 'ready', unread: 2 });
    expect([p.last().requests.length, p.last().conversations.length, p.last().sent.length]).toEqual([1, 1, 1]);
  });
  it('when it cannot be loaded and there is nothing to show, it says "unavailable", not an error', async () => {
    const p = probe(createInboxStore({ inbox: jest.fn(async () => ({ kind: 'failed' as const })) }));
    await p.render();
    expect(p.last().status).toBe('unavailable');
    expect(p.last().requests).toEqual([]);
  });
  it('with no server (mock data) it is simply empty', async () => {
    const p = probe(null);
    await p.render();
    expect(p.last()).toMatchObject({ status: 'ready', unread: 0, requests: [], conversations: [], sent: [] });
  });
});
