import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AccountReference } from './AccountReference';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';

const ctx = (state: AuthState, accountRef: string | null): AuthContextValue => ({ state, error: false, accountRef, signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), refused: jest.fn(), deleteAccount: jest.fn() });
const mount = async (value: AuthContextValue | null) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<AuthContext.Provider value={value}><AccountReference /></AuthContext.Provider>); });
  return r;
};
const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' | ');
const info = (r: ReturnType<typeof create>) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'About the account reference' && typeof n.props.onPress === 'function')[0];

describe('AccountReference', () => {
  it('Scenario: shows the reader\'s account reference code', async () => {
    const r = await mount(ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    expect(words(r)).toContain('Account reference');
    expect(words(r)).toContain('EXC-7K4Q-92M3');
  });

  it('the code can be selected and copied', async () => {
    const r = await mount(ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    const code = r.root.findAllByType(Text).find((t) => [t.props.children].flat().join('') === 'EXC-7K4Q-92M3')!;
    expect(code.props.selectable).toBe(true);
  });

  it('Scenario: the info button explains what it is for and what it is not, and a second press hides it', async () => {
    const r = await mount(ctx({ kind: 'approved' }, 'EXC-7K4Q-92M3'));
    expect(words(r)).not.toContain('contact us');
    await act(async () => { info(r).props.onPress(); });
    const text = words(r);
    expect(text).toContain('contact us');
    expect(text).toContain('cannot be used to sign in');
    expect(text).toContain('Google');
    expect(info(r).props.accessibilityState).toMatchObject({ expanded: true });
    await act(async () => { info(r).props.onPress(); });
    expect(words(r)).not.toContain('contact us');
  });

  it('is nothing with no sign-in (mock data), when not approved, or on a server that makes no accounts', async () => {
    for (const value of [null, ctx({ kind: 'signedOut' }, null), ctx({ kind: 'pending' }, 'EXC-7K4Q-92M3'), ctx({ kind: 'approved' }, null)]) {
      expect((await mount(value)).toJSON()).toBeNull();
    }
  });
});
