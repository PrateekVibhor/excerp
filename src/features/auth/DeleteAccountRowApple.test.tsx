import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { DeleteAccountRow } from './DeleteAccountRow';
import { AuthContext, type AuthContextValue } from './useAuth';

const value = (provider: AuthContextValue['provider'], deleteAccount = jest.fn(async (_o?: { wipe?: boolean }) => true)): AuthContextValue => ({
  state: { kind: 'approved' }, error: false, accountRef: null, provider, signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), deleteAccount, refused: jest.fn(),
});
const mount = async (ctx: AuthContextValue) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<AuthContext.Provider value={ctx}><DeleteAccountRow /></AuthContext.Provider>); });
  return r;
};
const press = (r: ReturnType<typeof create>, label: string) => act(async () => { r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress(); });
const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' ');

describe('DeleteAccountRow for an Apple reader', () => {
  it('says up front that Apple will be asked again, so the sheet is not a surprise; a Google reader is told nothing of the kind', async () => {
    const apple = await mount(value('apple'));
    await press(apple, 'Delete account');
    expect(words(apple)).toContain('sign in with Apple again');
    const google = await mount(value('google'));
    await press(google, 'Delete account');
    expect(words(google)).not.toContain('Apple');
  });

  it('when it does not go through, an Apple reader is told it may be because Apple\'s sheet was closed', async () => {
    const apple = await mount(value('apple', jest.fn(async () => false)));
    await press(apple, 'Delete account');
    await press(apple, 'Yes, delete my account');
    expect(words(apple)).toContain("Couldn't delete your account. Check your connection and sign in with Apple when asked, then try again.");
    const google = await mount(value('google', jest.fn(async () => false)));
    await press(google, 'Delete account');
    await press(google, 'Yes, delete my account');
    expect(words(google)).toContain("Couldn't delete your account. Check your connection and try again.");
  });
});
