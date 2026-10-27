import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { AuthGate } from '../auth/AuthGate';
import { AuthContext, type AuthState } from '../auth/useAuth';
import { byLabel, mount, press, text, unmountAll } from '../readers/testing';
import { INTRO_CARDS } from './introCopy';
import { IntroGate, resetIntroForTests } from './IntroGate';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ introStore: { isHidden: async () => false, hide: async () => {} } }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const store = (hidden: boolean | 'hang' | 'fail' = false) => ({
  isHidden: jest.fn(() => (hidden === 'hang' ? new Promise<boolean>(() => {}) : Promise.resolve(hidden === true))),
  hide: jest.fn(async () => {}),
});
const open = (s: ReturnType<typeof store>) =>
  mount(<SafeAreaProvider initialMetrics={metrics}><IntroGate store={s}><Text>THE APP</Text></IntroGate></SafeAreaProvider>);
const TITLE = 'Never miss what matters in tech';

beforeEach(() => { jest.useFakeTimers(); resetIntroForTests(); });
afterEach(async () => { await unmountAll(); jest.useRealTimers(); });

describe('the intro cards at app open', () => {
  it('shows on a fresh start, with the app underneath ready', async () => {
    const r = await open(store());
    expect(text(r)).toContain(TITLE);
    expect(text(r)).toContain('THE APP');
  });

  it('the card copy is exactly the three cards', () => {
    expect(INTRO_CARDS).toEqual([
      { title: 'Never miss what matters in tech', body: "Swipe through a fast, short feed of the day's tech and AI stories. Save the good ones. Skip the rest." },
      { title: 'Turn a job posting into a learning plan', body: 'Paste a role you want. Excerp pulls out the skills it asks for and lines up articles and guides to learn each one.' },
      { title: "See where you're strong, and where you're thin", body: 'Every skill shows how well it is covered, so you know what to study first. Your reading list keeps everything in one place.' },
    ]);
  });

  it('Skip leaves without storing anything, and the app is there', async () => {
    const s = store();
    const r = await open(s);
    await press(r, 'Skip');
    expect(text(r)).not.toContain(TITLE);
    expect(text(r)).toContain('THE APP');
    expect(s.hide).not.toHaveBeenCalled();
  });

  it('ticking the box and then leaving stores the choice; unticked, Get started stores nothing', async () => {
    const s = store();
    const r = await open(s);
    await press(r, "Don't show this again");
    await press(r, 'Skip');
    expect(s.hide).toHaveBeenCalledTimes(1);

    resetIntroForTests();
    const s2 = store();
    const r2 = await open(s2);
    await press(r2, 'Next');
    await press(r2, 'Next');
    await press(r2, 'Get started');
    expect(s2.hide).not.toHaveBeenCalled();
  });

  it('a reader who chose not to see it again goes straight to the app', async () => {
    const r = await open(store(true));
    expect(text(r)).not.toContain(TITLE);
    expect(text(r)).toContain('THE APP');
  });

  it('a slow storage does not hold the app: the cards show once the wait is over', async () => {
    const r = await open(store('hang'));
    expect(text(r)).not.toContain(TITLE);
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(text(r)).toContain(TITLE);
    expect(text(r)).toContain('THE APP');
  });

  it('a storage that fails shows the cards and does not crash', async () => {
    const s = { isHidden: jest.fn(async () => { throw new Error('no'); }), hide: jest.fn(async () => { throw new Error('no'); }) };
    const r = await open(s as never);
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(text(r)).toContain(TITLE);
    await press(r, "Don't show this again");
    await press(r, 'Skip');
    expect(text(r)).toContain('THE APP');
  });

  it('once per start: left once, it does not come back when the app is opened again in the same run', async () => {
    const s = store();
    const r = await open(s);
    await press(r, 'Skip');
    await unmountAll();
    const again = await open(s);
    expect(text(again)).not.toContain(TITLE);
    expect(text(again)).toContain('THE APP');
  });

  it('the checkbox, Skip and the page dots are named for a screen reader', async () => {
    const r = await open(store());
    const box = byLabel(r, "Don't show this again")[0]!;
    expect(box.props.accessibilityRole).toBe('checkbox');
    expect(box.props.accessibilityState).toMatchObject({ checked: false });
    await press(r, "Don't show this again");
    expect(byLabel(r, "Don't show this again")[0]!.props.accessibilityState).toMatchObject({ checked: true });
    expect(byLabel(r, 'Skip')).toHaveLength(1);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card 1 of 3').length).toBeGreaterThan(0);
  });

  it('inside the sign-in gate the cards never appear over sign-in, waiting or a connection problem, only once the reader is approved', async () => {
    const inGate = (kind: AuthState['kind']) =>
      mount(
        <SafeAreaProvider initialMetrics={metrics}>
          <AuthContext.Provider value={{ state: { kind } as AuthState, error: false, accountRef: null, signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), refused: jest.fn(), deleteAccount: jest.fn() } as never}>
            <AuthGate><IntroGate store={store()}><Text>THE APP</Text></IntroGate></AuthGate>
          </AuthContext.Provider>
        </SafeAreaProvider>,
      );
    for (const kind of ['signedOut', 'pending', 'connectionProblem', 'loading'] as const) {
      expect(text(await inGate(kind))).not.toContain(TITLE);
      await unmountAll();
    }
    expect(text(await inGate('approved'))).toContain(TITLE);
  });
});
