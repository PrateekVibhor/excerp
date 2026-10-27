import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Path } from 'react-native-svg';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { colors } from '../../theme';
import { AuthGate } from './AuthGate';
import { ConnectionProblemScreen } from './ConnectionProblemScreen';
import { GOOGLE_G_COLORS } from './GoogleG';
import { SignInScreen } from './SignInScreen';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';
import { WaitingScreen } from './WaitingScreen';

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };

function fakeAuth(state: AuthState, over: Partial<AuthContextValue> = {}): AuthContextValue {
  return { state, error: false, accountRef: null, signIn: jest.fn(async () => {}), checkAgain: jest.fn(async () => {}), signOut: jest.fn(async () => {}), refused: jest.fn(async () => {}), deleteAccount: jest.fn(async () => true), ...over };
}
async function show(node: React.ReactNode, auth: AuthContextValue | null) {
  let r!: ReturnType<typeof create>;
  await act(async () => {
    r = create(<SafeAreaProvider initialMetrics={metrics}><AuthContext.Provider value={auth}>{node}</AuthContext.Provider></SafeAreaProvider>);
  });
  const texts = () => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
  const button = (label: string) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  const press = async (label: string) => { await act(async () => { await button(label).props.onPress(); }); };
  return { r, texts, text: () => texts().join(' | '), button, press };
}
const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };

describe('SignInScreen', () => {
  it('Scenario: First launch asks for sign-in - a welcome, who it is for, and the Google button', async () => {
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }));
    expect(screen.text()).toContain('Welcome to Excerp');
    expect(screen.text()).toContain('Keep it simple');
    expect(screen.text()).not.toContain('Access is limited');
    expect(screen.button('Sign in with Google')).toBeTruthy();
  });

  it('the title, subtitle and button sit as one group in the vertical middle of the screen, not nearer the top or bottom', async () => {
    // Insets are deliberately uneven (20 at the top, 0 at the bottom), as on a real phone, where unequal padding pushed the group off center.
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }));
    const frame = screen.r.root.findAll((n) => { const st = StyleSheet.flatten(n.props.style); return st?.flex === 1 && st?.justifyContent === 'center'; })[0];
    const style = StyleSheet.flatten(frame.props.style);
    expect(style.justifyContent).toBe('center');
    expect(style.paddingTop).toBe(style.paddingBottom); // equal space above and below, so the middle of the group is the middle of the screen
    expect(style.paddingTop).toBeGreaterThanOrEqual(20); // and never under the status bar or home indicator
  });

  it('pressing the button starts Google sign-in', async () => {
    const auth = fakeAuth({ kind: 'signedOut' });
    const screen = await show(<SignInScreen />, auth);
    await screen.press('Sign in with Google');
    expect(auth.signIn).toHaveBeenCalledTimes(1);
  });

  it('the G is drawn in Google\'s four standard colors, unrecolored and with none of ours', async () => {
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }));
    const fills = screen.r.root.findAllByType(Path).map((n) => n.props.fill as string);
    expect(fills).toHaveLength(4);
    expect([...fills].sort()).toEqual(Object.values(GOOGLE_G_COLORS).sort());
    const ours: string[] = [...Object.values(colors.text), colors.detail.backBg, colors.detail.backBorder];
    expect(fills.some((f) => ours.includes(f))).toBe(false);
  });

  it('the container uses only existing theme tokens: the pill fill, border and text colors of the Profile screen', async () => {
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }));
    const style = StyleSheet.flatten(screen.button('Sign in with Google').props.style);
    expect(style.backgroundColor).toBe(colors.detail.backBg);
    expect(style.borderColor).toBe(colors.detail.backBorder);
    expect(style.borderWidth).toBe(1);
    expect(style.borderRadius).toBe(999);
    const label = screen.r.root.findAllByType(Text).find((t) => t.props.children === 'Sign in with Google')!;
    expect(StyleSheet.flatten(label.props.style).color).toBe(colors.text.primary);
  });

  it('Scenario: Reader cancels the Google sign-in - no error message is shown', async () => {
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }, { error: false }));
    expect(screen.text()).not.toMatch(/couldn't|error|failed/i);
  });

  it('a failed sign-in says so, as an alert', async () => {
    const screen = await show(<SignInScreen />, fakeAuth({ kind: 'signedOut' }, { error: true }));
    expect(screen.text()).toContain("Couldn't sign in with Google. Try again.");
    expect(screen.r.root.findAll((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
  });

  it('a second press while signing in is ignored', async () => {
    const d = deferred();
    const auth = fakeAuth({ kind: 'signedOut' }, { signIn: jest.fn(() => d.promise) });
    const screen = await show(<SignInScreen />, auth);
    await act(async () => { screen.button('Sign in with Google').props.onPress(); });
    await act(async () => { screen.button('Sign in with Google').props.onPress(); });
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    await act(async () => { d.release(); });
  });

  it('renders nothing outside the sign-in provider', async () => {
    const screen = await show(<SignInScreen />, null);
    expect(screen.texts()).toEqual([]);
    expect(screen.r.root.findAll((n) => typeof n.props.onPress === 'function')).toEqual([]);
  });
});

describe('WaitingScreen', () => {
  it('Scenario: Reader not on the list sees the waiting message, and nothing says who is on the list', async () => {
    const screen = await show(<WaitingScreen />, fakeAuth({ kind: 'pending' }));
    expect(screen.text()).toContain('Waiting for approval');
    expect(screen.text()).toContain("isn't approved yet");
    expect(screen.text()).not.toMatch(/allow|list|invite|denied|rejected|blocked/i);
  });

  it('Check again asks the server, and says "still waiting" when the reader is still here afterwards', async () => {
    const auth = fakeAuth({ kind: 'pending' });
    const screen = await show(<WaitingScreen />, auth);
    expect(screen.text()).not.toContain('Still waiting');
    await screen.press('Check again');
    expect(auth.checkAgain).toHaveBeenCalledTimes(1);
    expect(screen.text()).toContain('Still waiting. Check again later.');
  });

  it('the button shows it is working, and cannot be pressed twice at once', async () => {
    const d = deferred();
    const auth = fakeAuth({ kind: 'pending' }, { checkAgain: jest.fn(() => d.promise) });
    const screen = await show(<WaitingScreen />, auth);
    await act(async () => { screen.button('Check again').props.onPress(); });
    expect(screen.text()).toContain('Checking…');
    await act(async () => { screen.button('Checking…').props.onPress(); });
    expect(auth.checkAgain).toHaveBeenCalledTimes(1);
    await act(async () => { d.release(); });
    expect(screen.text()).toContain('Check again');
  });

  it('a reader with the wrong account can sign out of it', async () => {
    const auth = fakeAuth({ kind: 'pending' });
    const screen = await show(<WaitingScreen />, auth);
    await screen.press('Use a different account');
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionProblemScreen', () => {
  it('Scenario: connection problem is not a refusal - it says the server could not be reached and that it is not about the account', async () => {
    const screen = await show(<ConnectionProblemScreen />, fakeAuth({ kind: 'connectionProblem' }));
    expect(screen.text()).toContain("Couldn't reach the server");
    expect(screen.text()).toContain('not about your account');
    expect(screen.text()).not.toMatch(/approval|approved|waiting/i);
  });

  it('Try again asks again, once at a time', async () => {
    const d = deferred();
    const auth = fakeAuth({ kind: 'connectionProblem' }, { checkAgain: jest.fn(() => d.promise) });
    const screen = await show(<ConnectionProblemScreen />, auth);
    await act(async () => { screen.button('Try again').props.onPress(); });
    expect(screen.text()).toContain('Trying…');
    await act(async () => { screen.button('Trying…').props.onPress(); });
    expect(auth.checkAgain).toHaveBeenCalledTimes(1);
    await act(async () => { d.release(); });
  });
});

describe('AuthGate', () => {
  const App = () => <Text>THE APP</Text>;

  it('Scenario: Approved reader gets in - the app is shown', async () => {
    const screen = await show(<AuthGate><App /></AuthGate>, fakeAuth({ kind: 'approved' }));
    expect(screen.text()).toBe('THE APP');
  });

  it('every other state shows its own screen and none of the app', async () => {
    const cases: Array<[AuthState['kind'], string]> = [['signedOut', 'Welcome to Excerp'], ['pending', 'Waiting for approval'], ['connectionProblem', "Couldn't reach the server"]];
    for (const [kind, words] of cases) {
      const screen = await show(<AuthGate><App /></AuthGate>, fakeAuth({ kind } as AuthState));
      expect(screen.text()).toContain(words);
      expect(screen.text()).not.toContain('THE APP');
    }
  });

  it('while the stored session is being read, a spinner and none of the app', async () => {
    const screen = await show(<AuthGate><App /></AuthGate>, fakeAuth({ kind: 'loading' }));
    expect(screen.text()).toBe('');
    expect(screen.r.root.findAll((n) => (n.type as unknown as { displayName?: string }).displayName === 'ActivityIndicator' || n.props.color === colors.text.secondary).length).toBeGreaterThan(0);
  });

  it('Scenario: Mock data - with no sign-in provider the app is shown and no sign-in screen appears', async () => {
    const screen = await show(<AuthGate><App /></AuthGate>, null);
    expect(screen.text()).toBe('THE APP');
  });
});
