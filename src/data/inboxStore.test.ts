import { createInboxStore } from './inboxStore';
import type { Inbox, SocialResult } from './socialApi';

const inbox = (unread: number): Inbox => ({ cursor: unread, unread, requests: [], conversations: [], sent: [] });
const api = (results: Array<SocialResult<Inbox> | (() => Promise<SocialResult<Inbox>>)>) => {
  const queue = [...results];
  return { inbox: jest.fn(async () => { const next = queue.shift()!; return typeof next === 'function' ? next() : next; }) };
};

describe('inboxStore', () => {
  it('starts empty, loads once asked, and tells listeners', async () => {
    const source = api([{ kind: 'ok', value: inbox(2) }]);
    const store = createInboxStore(source);
    expect(store.get()).toEqual({ status: 'idle', inbox: null });
    const heard = jest.fn();
    store.subscribe(heard);
    await store.refresh();
    expect(store.get()).toEqual({ status: 'ready', inbox: inbox(2) });
    expect(heard).toHaveBeenCalled();
  });

  it('asking while a refresh is under way gets that one: one request, not two', async () => {
    let release!: (r: SocialResult<Inbox>) => void;
    const source = api([() => new Promise((resolve) => { release = resolve; })]);
    const store = createInboxStore(source);
    const a = store.refresh();
    const b = store.refresh();
    release({ kind: 'ok', value: inbox(1) });
    await Promise.all([a, b]);
    expect(source.inbox).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps what was there; with nothing there it says "unavailable"', async () => {
    const source = api([{ kind: 'failed' }, { kind: 'ok', value: inbox(3) }, { kind: 'failed' }]);
    const store = createInboxStore(source);
    await store.refresh();
    expect(store.get()).toEqual({ status: 'unavailable', inbox: null });
    await store.refresh();
    await store.refresh();
    expect(store.get()).toEqual({ status: 'ready', inbox: inbox(3) });
  });

  it('a refused session or account is reported to the sign-in layer', async () => {
    const refused = jest.fn();
    const store = createInboxStore(api([{ kind: 'unauthorized' }, { kind: 'refused', status: 403, code: '' }, { kind: 'refused', status: 404, code: '' }]), refused);
    await store.refresh();
    await store.refresh();
    await store.refresh();
    expect(refused.mock.calls).toEqual([[401], [403]]);
  });

  it('Scenario: another reader signs in - everything is forgotten, and an answer still on its way is thrown away', async () => {
    let release!: (r: SocialResult<Inbox>) => void;
    const store = createInboxStore(api([{ kind: 'ok', value: inbox(5) }, () => new Promise((resolve) => { release = resolve; })]));
    await store.refresh();
    const late = store.refresh();
    store.reset();
    expect(store.get()).toEqual({ status: 'idle', inbox: null });
    release({ kind: 'ok', value: inbox(9) });
    await late;
    expect(store.get()).toEqual({ status: 'idle', inbox: null }); // the old reader's inbox did not come back
  });

  it('unsubscribing stops the calls', async () => {
    const store = createInboxStore(api([{ kind: 'ok', value: inbox(1) }]));
    const heard = jest.fn();
    store.subscribe(heard)();
    await store.refresh();
    expect(heard).not.toHaveBeenCalled();
  });
});
