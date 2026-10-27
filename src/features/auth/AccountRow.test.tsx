import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import type { AuthApi } from '../../data/authApi';
import type { SessionStore, StoredSession } from '../../data/sessionStore';
import { AccountRow } from './AccountRow';
import { AuthProvider } from './AuthProvider';
import type { GoogleSignInClient } from './googleSignIn';
import { AuthContext, useAuth, type AuthContextValue, type AuthState } from './useAuth';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const value = (state: AuthState, signOut = jest.fn(async () => {})): AuthContextValue => ({ state, error: false, accountRef: null, signIn: jest.fn(), checkAgain: jest.fn(), signOut, refused: jest.fn(), deleteAccount: jest.fn(async () => true) });
const button = (r: ReturnType<typeof create>) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Sign out' && typeof n.props.onPress === 'function')[0];

describe('AccountRow', () => {
  it('is a Sign out row that says the reader\'s data stays on the device, and pressing it signs out', async () => {
    const signOut = jest.fn(async () => {});
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<AuthContext.Provider value={value({ kind: 'approved' }, signOut)}><AccountRow /></AuthContext.Provider>); });
    expect(r.root.findAllByType(Text).map((t) => t.props.children).join(' ')).toContain('stay on this device');
    await act(async () => { button(r).props.onPress(); });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('is nothing at all with no sign-in (mock data), or when the reader is not signed in', async () => {
    for (const ctx of [null, value({ kind: 'pending' }), value({ kind: 'signedOut' })]) {
      let r!: ReturnType<typeof create>;
      await act(async () => { r = create(<AuthContext.Provider value={ctx}><AccountRow /></AuthContext.Provider>); });
      expect(r.toJSON()).toBeNull();
    }
  });

  it('Scenario: Sign out - the sign-in screen state shows, and the profile, reading list and verified records are still on the device', async () => {
    await AsyncStorage.clear();
    const kept = { 'swipy:profile': '{"display_name":"Vibhor"}', 'swipy:reading_list': '[{"id":"a"}]', 'swipy:verified': '[{"article_id":"a"}]', 'swipy:swipes': '[]' };
    for (const [k, v] of Object.entries(kept)) await AsyncStorage.setItem(k, v);

    const stored: StoredSession = { token: 't', expires_at: '2026-11-08T12:00:00.000Z', last_approved_at: new Date().toISOString() };
    let saved: StoredSession | null = stored;
    const sessions: SessionStore = { load: async () => saved, save: async (s) => { saved = s; }, clear: async () => { saved = null; } };
    const api: AuthApi = { signIn: jest.fn(), signInWithApple: jest.fn(), checkSession: jest.fn(async () => ({ kind: 'approved' as const, expires_at: stored.expires_at })), signOut: jest.fn(async () => {}), deleteAccount: jest.fn(async () => 'deleted' as const) };
    const google: GoogleSignInClient = { signIn: jest.fn(), signInSilently: jest.fn(), signOut: jest.fn(async () => {}) };

    const out: { auth: AuthContextValue | null } = { auth: null };
    function Probe() { out.auth = useAuth(); return <AccountRow />; }
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<AuthProvider api={api} sessions={sessions} google={google}><Probe /></AuthProvider>); });
    await act(async () => {});
    expect(out.auth!.state.kind).toBe('approved');
    await act(async () => { button(r).props.onPress(); });
    await act(async () => {});

    expect(out.auth!.state.kind).toBe('signedOut');
    expect(saved).toBeNull();
    for (const [k, v] of Object.entries(kept)) expect(await AsyncStorage.getItem(k)).toBe(v);
  });
});
