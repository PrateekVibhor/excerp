import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { DeleteAccountRow } from './DeleteAccountRow';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';

const value = (state: AuthState, deleteAccount = jest.fn(async (_options?: { wipe?: boolean }) => true)): AuthContextValue => ({ state, error: false, accountRef: null, signIn: jest.fn(), checkAgain: jest.fn(), signOut: jest.fn(), refused: jest.fn(), deleteAccount });
const mount = async (ctx: AuthContextValue | null) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<AuthContext.Provider value={ctx}><DeleteAccountRow /></AuthContext.Provider>); });
  return r;
};
const press = (r: ReturnType<typeof create>, label: string) => act(async () => { r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress(); });
const has = (r: ReturnType<typeof create>, label: string) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function').length > 0;
const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' ');

describe('DeleteAccountRow', () => {
  it('is nothing with no sign-in (mock data) or when the reader is not approved', async () => {
    for (const ctx of [null, value({ kind: 'pending' }), value({ kind: 'signedOut' })]) expect((await mount(ctx)).toJSON()).toBeNull();
  });

  it('Scenario: Pressing Delete account asks first - nothing is deleted yet, and the question says what goes and what stays', async () => {
    const deleteAccount = jest.fn(async () => true);
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    expect(deleteAccount).not.toHaveBeenCalled();
    const text = words(r);
    expect(text).toContain('email'); // the policy's list: email address and sign-in sessions,
    expect(text).toContain('leaderboard'); // leaderboard entries, and a place on the approved or waiting list
    expect(text).toContain('stay on this phone'); // and what it does not remove
    expect(has(r, 'Yes, delete my account')).toBe(true);
    expect(has(r, 'Cancel')).toBe(true);
  });

  it('Scenario: Cancel - the question closes and nothing is deleted', async () => {
    const deleteAccount = jest.fn(async () => true);
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    await press(r, 'Cancel');
    expect(has(r, 'Yes, delete my account')).toBe(false);
    expect(has(r, 'Delete account')).toBe(true);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('Scenario: Confirm - the account is deleted once, even when pressed twice quickly', async () => {
    let finish!: (ok: boolean) => void;
    const deleteAccount = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    await press(r, 'Yes, delete my account');
    await press(r, 'Yes, delete my account');
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });

  it('Scenario: Delete fails - an error is shown, the reader can try again, and nothing says it worked', async () => {
    const deleteAccount = jest.fn(async () => false);
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    await press(r, 'Yes, delete my account');
    expect(words(r)).toContain("Couldn't delete your account");
    await press(r, 'Yes, delete my account');
    expect(deleteAccount).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Keep or remove the data on this phone - Keep is chosen to begin with, and the reader chooses before anything is deleted', async () => {
    const deleteAccount = jest.fn(async (_options?: { wipe?: boolean }) => true);
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    const keep = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Keep my data on this phone')[0];
    const wipe = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Also remove my data from this phone')[0];
    expect(keep.props.accessibilityRole).toBe('radio');
    expect(keep.props.accessibilityState).toMatchObject({ selected: true });
    expect(wipe.props.accessibilityState).toMatchObject({ selected: false });
    await press(r, 'Yes, delete my account');
    expect(deleteAccount).toHaveBeenCalledWith({ wipe: false });
  });

  it('Scenario: Choosing to remove it - the question says what will go, and the delete is asked for with wipe', async () => {
    const deleteAccount = jest.fn(async (_options?: { wipe?: boolean }) => true);
    const r = await mount(value({ kind: 'approved' }, deleteAccount));
    await press(r, 'Delete account');
    expect(words(r)).toContain('stay on this phone');
    await press(r, 'Also remove my data from this phone');
    expect(words(r)).toContain('removed from this phone too');
    expect(words(r)).not.toContain('stay on this phone');
    await press(r, 'Yes, delete my account');
    expect(deleteAccount).toHaveBeenCalledWith({ wipe: true });
  });

  it('the question lists what leaves the server, in the words of the privacy policy', async () => {
    const r = await mount(value({ kind: 'approved' }));
    await press(r, 'Delete account');
    const text = words(r);
    for (const part of ['email address', 'profile', 'saved articles', 'verified articles', 'skip counts', 'leaderboard entries', 'sign-in sessions']) expect(text).toContain(part);
  });

  it('cancelling forgets the choice: the next time Keep is chosen again', async () => {
    const r = await mount(value({ kind: 'approved' }));
    await press(r, 'Delete account');
    await press(r, 'Also remove my data from this phone');
    await press(r, 'Cancel');
    await press(r, 'Delete account');
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Keep my data on this phone')[0].props.accessibilityState).toMatchObject({ selected: true });
  });

  it('Scenario: it says that messages already sent stay with the people they were sent to, without the sender\'s name', async () => {
    const r = await mount(value({ kind: 'approved' }));
    await press(r, 'Delete account');
    expect(words(r)).toContain('Messages you sent stay with the readers you sent them to, without your name');
  });
});
