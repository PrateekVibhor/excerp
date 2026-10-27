// The Apple button on the sign-in screen: only where Sign in with Apple is on offer, beside Google's and never instead of it.
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create } from 'react-test-renderer';
import { SignInScreen } from './SignInScreen';
import { AuthContext, type AuthContextValue } from './useAuth';

jest.mock('expo-apple-authentication', () => {
  const { View } = require('react-native');
  const React = require('react');
  return {
    AppleAuthenticationButton: (props: object) => React.createElement(View, props),
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
  };
});

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const auth = (over: Partial<AuthContextValue> = {}): AuthContextValue => ({
  state: { kind: 'signedOut' }, error: false, accountRef: null, signIn: jest.fn(async () => {}), checkAgain: jest.fn(async () => {}), signOut: jest.fn(async () => {}),
  deleteAccount: jest.fn(async () => true), refused: jest.fn(async () => {}), ...over,
});
async function show(ctx: AuthContextValue) {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SafeAreaProvider initialMetrics={metrics}><AuthContext.Provider value={ctx}><SignInScreen /></AuthContext.Provider></SafeAreaProvider>); });
  const apple = () => r.root.findAll((n) => n.props.testID === 'sign-in-with-apple' && typeof n.props.onPress === 'function')[0];
  const google = () => r.root.findAll((n) => n.props.accessibilityLabel === 'Sign in with Google' && typeof n.props.onPress === 'function')[0];
  const text = () => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' | ');
  return { r, apple, google, text };
}

describe('SignInScreen with Sign in with Apple', () => {
  it('Scenario: Apple is not on offer (Android, an old build, mock data) - the screen is Google\'s alone, as before', async () => {
    for (const ctx of [auth(), auth({ appleAvailable: false, signInWithApple: jest.fn() })]) {
      const s = await show(ctx);
      expect(s.apple()).toBeUndefined();
      expect(s.google()).toBeTruthy();
    }
  });

  it('Scenario: Apple is on offer - Apple\'s own button (Sign in with Apple, white with an outline, pill-shaped like the Google one) sits above Google\'s', async () => {
    const s = await show(auth({ appleAvailable: true, signInWithApple: jest.fn(async () => {}) }));
    expect(s.apple()).toBeTruthy();
    expect(s.apple().props.buttonType).toBe(0); // SIGN_IN: "Sign in with Apple"
    expect(s.apple().props.buttonStyle).toBe(1); // WHITE_OUTLINE
    expect(s.apple().props.cornerRadius).toBe(24);
    expect(s.google()).toBeTruthy();
    const order = s.r.root.findAll((n) => n.props.testID === 'sign-in-with-apple' || n.props.accessibilityLabel === 'Sign in with Google').map((n) => (n.props.testID ? 'apple' : 'google'));
    expect(order[0]).toBe('apple');
  });

  it('pressing Apple\'s button starts Apple sign-in and not Google\'s', async () => {
    const ctx = auth({ appleAvailable: true, signInWithApple: jest.fn(async () => {}) });
    const s = await show(ctx);
    await act(async () => { await s.apple().props.onPress(); });
    expect(ctx.signInWithApple).toHaveBeenCalledTimes(1);
    expect(ctx.signIn).not.toHaveBeenCalled();
  });

  it('a second press while one sign-in is under way is ignored, whichever button it is', async () => {
    let release!: () => void;
    const ctx = auth({ appleAvailable: true, signInWithApple: jest.fn(() => new Promise<void>((r) => { release = r; })) });
    const s = await show(ctx);
    await act(async () => { s.apple().props.onPress(); });
    await act(async () => { s.apple().props.onPress(); s.google().props.onPress(); });
    expect(ctx.signInWithApple).toHaveBeenCalledTimes(1);
    expect(ctx.signIn).not.toHaveBeenCalled();
    await act(async () => { release(); });
  });

  it('a failed sign-in with Apple on offer says "Couldn\'t sign in", since it could have been either; with Google alone the words are unchanged', async () => {
    expect((await show(auth({ error: true, appleAvailable: true, signInWithApple: jest.fn() }))).text()).toContain("Couldn't sign in. Try again.");
    expect((await show(auth({ error: true }))).text()).toContain("Couldn't sign in with Google. Try again.");
  });
});
