import { AppState } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { AccountSync as Engine } from '../../data/accountSync';
import { AccountSync } from './AccountSync';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ accountSync: {}, inboxStore: null, listsStore: null, setRefusedHandler: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setRefusedHandler } = require('../../data') as { setRefusedHandler: jest.Mock };

const engine = () => ({ start: jest.fn(async () => {}), stop: jest.fn(), syncNow: jest.fn(async () => {}), flushSkips: jest.fn(async () => {}), detach: jest.fn(async () => {}), enabled: () => false, noticePending: () => false, acknowledgeNotice: jest.fn(async () => {}), subscribeNotice: () => () => {} }) satisfies Engine;
const ctx = (state: AuthState, accountRef: string | null, refused = jest.fn(async () => {})): AuthContextValue => ({ state, error: false, accountRef, signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), refused, deleteAccount: jest.fn() });

let appStateListener: ((s: string) => void) | undefined;
const removeListener = jest.fn();
beforeEach(() => {
  appStateListener = undefined;
  removeListener.mockClear();
  setRefusedHandler.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
    appStateListener = fn;
    return { remove: removeListener };
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

const mount = async (sync: Engine, value: AuthContextValue | null) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<AuthContext.Provider value={value}><AccountSync sync={sync} /></AuthContext.Provider>); });
  return r;
};

describe('AccountSync', () => {
  it('starts when the reader is approved on an account, and stops when the component goes away', async () => {
    const sync = engine();
    const r = await mount(sync, ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    expect(sync.start).toHaveBeenCalledTimes(1);
    await act(async () => r.unmount());
    expect(sync.stop).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a sign-in (mock data), when not approved, or on a server without accounts', async () => {
    for (const value of [null, ctx({ kind: 'signedOut' }, null), ctx({ kind: 'pending' }, null), ctx({ kind: 'approved' }, null)]) {
      const sync = engine();
      await mount(sync, value);
      expect(sync.start).not.toHaveBeenCalled();
    }
  });

  it('catches up when the app comes back to the front, and not for other changes', async () => {
    const sync = engine();
    await mount(sync, ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    await act(async () => { appStateListener?.('background'); });
    expect(sync.syncNow).not.toHaveBeenCalled();
    await act(async () => { appStateListener?.('active'); });
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
    expect(sync.flushSkips).toHaveBeenCalledTimes(1);
  });

  it('Scenario: switching to another account stops the first and starts afresh for the second', async () => {
    const sync = engine();
    const r = await mount(sync, ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    await act(async () => { r.update(<AuthContext.Provider value={ctx({ kind: 'approved' }, 'EXC-0000-ABCD')}><AccountSync sync={sync} /></AuthContext.Provider>); });
    expect(sync.stop).toHaveBeenCalledTimes(1);
    expect(sync.start).toHaveBeenCalledTimes(2);
  });

  it('what the server refuses while syncing is passed to the sign-in layer', async () => {
    const refused = jest.fn(async () => {});
    await mount(engine(), ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3', refused));
    const handler = setRefusedHandler.mock.calls[0][0] as (status: 401 | 403) => void;
    handler(401);
    expect(refused).toHaveBeenCalledWith(401);
  });

  describe('the inbox', () => {
    const inboxStore = () => ({ get: jest.fn(), subscribe: jest.fn(), refresh: jest.fn(async () => {}), reset: jest.fn() });
    const mountWith = async (sync: Engine, inbox: ReturnType<typeof inboxStore>, pollMs = 1000) => {
      let r!: ReturnType<typeof create>;
      await act(async () => { r = create(<AuthContext.Provider value={ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3')}><AccountSync sync={sync} inbox={inbox} pollMs={pollMs} /></AuthContext.Provider>); });
      return r;
    };

    it('is asked for at the start, when the app comes to the front, and on a timer - and forgotten when the reader leaves', async () => {
      jest.useFakeTimers();
      try {
        const inbox = inboxStore();
        const r = await mountWith(engine(), inbox);
        expect(inbox.refresh).toHaveBeenCalledTimes(1);
        await act(async () => { appStateListener?.('active'); });
        expect(inbox.refresh).toHaveBeenCalledTimes(2);
        await act(async () => { jest.advanceTimersByTime(2500); });
        expect(inbox.refresh).toHaveBeenCalledTimes(4);
        await act(async () => r.unmount());
        expect(inbox.reset).toHaveBeenCalledTimes(1);
        await act(async () => { jest.advanceTimersByTime(5000); });
        expect(inbox.refresh).toHaveBeenCalledTimes(4); // the timer is gone
      } finally {
        jest.useRealTimers();
      }
    });

    it('is not asked for when the reader is not on an account', async () => {
      const inbox = inboxStore();
      await act(async () => { create(<AuthContext.Provider value={ctx({ kind: 'signedOut' }, null)}><AccountSync sync={engine()} inbox={inbox} /></AuthContext.Provider>); });
      expect(inbox.refresh).not.toHaveBeenCalled();
    });
  });

  describe('the reader\'s lists', () => {
    const listsStore = () => ({ get: jest.fn(), subscribe: jest.fn(), refresh: jest.fn(async () => {}), patch: jest.fn(), touch: jest.fn(), drop: jest.fn(), reset: jest.fn() });
    const mountWith = async (lists: ReturnType<typeof listsStore>, pollMs = 1000) => {
      let r!: ReturnType<typeof create>;
      await act(async () => { r = create(<AuthContext.Provider value={ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3')}><AccountSync sync={engine()} lists={lists} pollMs={pollMs} /></AuthContext.Provider>); });
      return r;
    };

    it('are asked for at the start, when the app comes to the front and on a timer, and forgotten when the reader leaves (so the tab dot follows new coverage)', async () => {
      jest.useFakeTimers();
      try {
        const lists = listsStore();
        const r = await mountWith(lists);
        expect(lists.refresh).toHaveBeenCalledTimes(1);
        await act(async () => { appStateListener?.('active'); });
        expect(lists.refresh).toHaveBeenCalledTimes(2);
        await act(async () => { jest.advanceTimersByTime(2500); });
        expect(lists.refresh).toHaveBeenCalledTimes(4);
        await act(async () => r.unmount());
        expect(lists.reset).toHaveBeenCalledTimes(1);
        await act(async () => { jest.advanceTimersByTime(5000); });
        expect(lists.refresh).toHaveBeenCalledTimes(4);
      } finally {
        jest.useRealTimers();
      }
    });

    it('are not asked for when the reader is not on an account', async () => {
      const lists = listsStore();
      await act(async () => { create(<AuthContext.Provider value={ctx({ kind: 'signedOut' }, null)}><AccountSync sync={engine()} lists={lists} /></AuthContext.Provider>); });
      expect(lists.refresh).not.toHaveBeenCalled();
    });
  });
});
