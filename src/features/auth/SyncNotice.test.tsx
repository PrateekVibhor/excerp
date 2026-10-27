import { Modal, Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import type { AccountSync } from '../../data/accountSync';
import { SyncNotice } from './SyncNotice';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ accountSync: {} }));

const ctx = (state: AuthState): AuthContextValue => ({ state, error: false, accountRef: 'EXC-7K4Q-92M3', signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), refused: jest.fn(), deleteAccount: jest.fn() });
function engine(initiallyPending: boolean) {
  let pending = initiallyPending;
  const listeners = new Set<() => void>();
  const sync = {
    start: jest.fn(), stop: jest.fn(), syncNow: jest.fn(), flushSkips: jest.fn(), detach: jest.fn(), enabled: () => true,
    noticePending: () => pending,
    acknowledgeNotice: jest.fn(async () => { pending = false; listeners.forEach((l) => l()); }),
    subscribeNotice: (l: () => void) => { listeners.add(l); return () => void listeners.delete(l); },
  } as unknown as AccountSync & { acknowledgeNotice: jest.Mock };
  return { sync, appear: () => { pending = true; listeners.forEach((l) => l()); } };
}
const mount = async (sync: AccountSync, value: AuthContextValue | null, browser?: { openBrowserAsync: jest.Mock }) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<AuthContext.Provider value={value}><SyncNotice sync={sync} browser={browser} /></AuthContext.Provider>); });
  return r;
};
const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' | ');
const press = (r: ReturnType<typeof create>, label: string) => act(async () => { r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress(); });

describe('SyncNotice', () => {
  it('Scenario: nothing shows until syncing has started on the reader\'s own doing', async () => {
    const { sync } = engine(false);
    expect((await mount(sync, ctx({ kind: 'approved' }))).toJSON()).toBeNull();
  });

  it('Scenario: when it starts, the reader is told what is kept, that skips are counted, who sees what, and how to delete it all', async () => {
    const { sync } = engine(true);
    const r = await mount(sync, ctx({ kind: 'approved' }));
    const text = words(r);
    expect(r.root.findAllByType(Modal)).toHaveLength(1);
    expect(text).toContain('now saved to your account');
    expect(text).toContain('profile, saved articles and verified articles');
    expect(text).toContain('skip');
    expect(text).toContain('leaderboard name');
    expect(text).toContain('Delete account');
  });

  it('it appears when the notice arrives while the app is open', async () => {
    const { sync, appear } = engine(false);
    const r = await mount(sync, ctx({ kind: 'approved' }));
    await act(async () => appear());
    expect(r.root.findAllByType(Modal)).toHaveLength(1);
  });

  it('Scenario: OK dismisses it for good - the engine is told, and it does not come back', async () => {
    const { sync } = engine(true);
    const r = await mount(sync, ctx({ kind: 'approved' }));
    await press(r, 'OK');
    expect(sync.acknowledgeNotice).toHaveBeenCalledTimes(1);
    expect(r.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('it links to the privacy policy', async () => {
    const { sync } = engine(true);
    const browser = { openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) };
    const r = await mount(sync, ctx({ kind: 'approved' }), browser);
    await press(r, 'Read the privacy policy');
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://excerp.app/privacy');
  });

  it('is never shown without a sign-in (mock data) or when the reader is not approved', async () => {
    for (const value of [null, ctx({ kind: 'signedOut' }), ctx({ kind: 'pending' })]) {
      const { sync } = engine(true);
      expect((await mount(sync, value)).toJSON()).toBeNull();
    }
  });
});
