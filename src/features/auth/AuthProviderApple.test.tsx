// Sign in with Apple in the provider: the same rules as Google's sign-in, plus asking Apple again before an Apple account is deleted.
import { act, create } from 'react-test-renderer';
import type { AuthApi, SessionResult, SignInResult } from '../../data/authApi';
import type { SessionStore, StoredSession } from '../../data/sessionStore';
import { AuthProvider } from './AuthProvider';
import type { AppleSignInClient, AppleSignInOutcome } from './appleSignIn';
import type { GoogleSignInClient } from './googleSignIn';
import { useAuth, type AuthContextValue } from './useAuth';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const EXPIRES = '2026-11-22T12:00:00.000Z';
const REF = 'EXC-ABCD-EFGH';
const APPLE_SESSION: StoredSession = { token: 'apple-token', expires_at: EXPIRES, last_approved_at: NOW.toISOString(), account_ref: REF, provider: 'apple' };
const GOOGLE_SESSION: StoredSession = { token: 'google-token', expires_at: EXPIRES, last_approved_at: NOW.toISOString(), account_ref: REF };
const OK: AppleSignInOutcome = { kind: 'ok', identityToken: 'identity-token', authorizationCode: 'auth-code', nonce: 'raw-nonce' };

function setup(opts: { stored?: StoredSession | null; available?: boolean; apple?: AppleSignInOutcome; signIn?: SignInResult; session?: SessionResult; deleted?: 'deleted' | 'failed' } = {}) {
  let saved: StoredSession | null = opts.stored ?? null;
  const sessions: SessionStore & { current: () => StoredSession | null } = {
    current: () => saved,
    load: jest.fn(async () => saved),
    save: jest.fn(async (s: StoredSession) => { saved = s; }),
    clear: jest.fn(async () => { saved = null; }),
  };
  const api = {
    signIn: jest.fn(async (): Promise<SignInResult> => ({ kind: 'approved', token: 'google-new', expires_at: EXPIRES, account_ref: REF })),
    signInWithApple: jest.fn(async (): Promise<SignInResult> => opts.signIn ?? { kind: 'approved', token: 'apple-new', expires_at: EXPIRES, account_ref: REF }),
    checkSession: jest.fn(async (): Promise<SessionResult> => opts.session ?? { kind: 'approved', expires_at: EXPIRES, account_ref: REF }),
    signOut: jest.fn(async () => {}),
    deleteAccount: jest.fn(async (): Promise<'deleted' | 'failed'> => opts.deleted ?? 'deleted'),
  } satisfies AuthApi;
  const google = {
    signIn: jest.fn(async () => ({ kind: 'ok', idToken: 'google-id-token' }) as Awaited<ReturnType<GoogleSignInClient['signIn']>>),
    signInSilently: jest.fn(async () => ({ kind: 'ok', idToken: 'silent' }) as Awaited<ReturnType<GoogleSignInClient['signInSilently']>>),
    signOut: jest.fn(async () => {}),
  } satisfies GoogleSignInClient;
  const apple = { isAvailable: jest.fn(async () => opts.available ?? true), signIn: jest.fn(async () => opts.apple ?? OK) } satisfies AppleSignInClient;
  const identity = { deviceId: jest.fn(async () => 'device-1'), hold: jest.fn(async () => () => {}), forget: jest.fn(async () => {}) };
  return { sessions, api, google, apple, identity };
}

async function mount(deps: ReturnType<typeof setup>, withApple = true) {
  const out: { auth: AuthContextValue | null } = { auth: null };
  function Probe() { out.auth = useAuth(); return null; }
  await act(async () => {
    create(<AuthProvider api={deps.api} sessions={deps.sessions} google={deps.google} {...(withApple ? { apple: deps.apple } : {})} identity={deps.identity} now={() => NOW}><Probe /></AuthProvider>);
  });
  await act(async () => {});
  return { auth: () => out.auth!, kind: () => out.auth!.state.kind };
}
const run = (fn: () => Promise<unknown> | void) => act(async () => { await fn(); });

describe('AuthProvider: Sign in with Apple', () => {
  it('says whether Apple is on offer: only with an Apple client that reports it is available', async () => {
    expect((await mount(setup({ stored: null }))).auth().appleAvailable).toBe(true);
    expect((await mount(setup({ stored: null, available: false }))).auth().appleAvailable).toBe(false);
    expect((await mount(setup({ stored: null }), false)).auth().appleAvailable).toBe(false); // Android, mock data: no client
  });

  it('Scenario: approved - the server gets the token and the raw nonce, the session is kept as an Apple one, and the app opens on the account', async () => {
    const deps = setup({ stored: null });
    const app = await mount(deps);
    await run(() => app.auth().signInWithApple!());
    expect(deps.api.signInWithApple).toHaveBeenCalledWith('identity-token', 'raw-nonce');
    expect(deps.api.signIn).not.toHaveBeenCalled();
    expect(app.kind()).toBe('approved');
    expect(app.auth().accountRef).toBe(REF);
    expect(app.auth().provider).toBe('apple');
    expect(deps.sessions.current()).toEqual({ token: 'apple-new', expires_at: EXPIRES, last_approved_at: NOW.toISOString(), account_ref: REF, provider: 'apple' });
  });

  it('closing Apple\'s sheet is not an error', async () => {
    const deps = setup({ stored: null, apple: { kind: 'cancelled' } });
    const app = await mount(deps);
    await run(() => app.auth().signInWithApple!());
    expect(app.kind()).toBe('signedOut');
    expect(app.auth().error).toBe(false);
    expect(deps.api.signInWithApple).not.toHaveBeenCalled();
  });

  it('an Apple failure, or the server refusing the token, shows the sign-in error; the server being out of reach shows the connection problem; "pending" shows the waiting state', async () => {
    const failed = await mount(setup({ stored: null, apple: { kind: 'error' } }));
    await run(() => failed.auth().signInWithApple!());
    expect([failed.kind(), failed.auth().error]).toEqual(['signedOut', true]);
    const refused = await mount(setup({ stored: null, signIn: { kind: 'rejected' } }));
    await run(() => refused.auth().signInWithApple!());
    expect([refused.kind(), refused.auth().error]).toEqual(['signedOut', true]);
    const down = await mount(setup({ stored: null, signIn: { kind: 'unavailable' } }));
    await run(() => down.auth().signInWithApple!());
    expect(down.kind()).toBe('connectionProblem');
    const deps = setup({ stored: null, signIn: { kind: 'pending' } });
    const pending = await mount(deps);
    await run(() => pending.auth().signInWithApple!());
    expect(pending.kind()).toBe('pending');
    expect(deps.sessions.current()).toBeNull();
  });

  it('an Apple reader who opens the app again is checked with the stored session and stays an Apple reader; Google is never asked, even for a session with no account', async () => {
    const deps = setup({ stored: APPLE_SESSION });
    const app = await mount(deps);
    expect(app.kind()).toBe('approved');
    expect(app.auth().provider).toBe('apple');
    expect(deps.sessions.current()?.provider).toBe('apple');
    const noRef = setup({ stored: { ...APPLE_SESSION, account_ref: undefined }, session: { kind: 'approved', expires_at: EXPIRES } });
    await mount(noRef);
    expect(noRef.google.signInSilently).not.toHaveBeenCalled();
  });

  it('a Google reader is a Google reader: provider "google", and no Apple code is ever asked for', async () => {
    const deps = setup({ stored: GOOGLE_SESSION });
    const app = await mount(deps);
    expect(app.auth().provider).toBe('google');
    await run(() => app.auth().deleteAccount());
    expect(deps.apple.signIn).not.toHaveBeenCalled();
    expect(deps.api.deleteAccount).toHaveBeenCalledWith('google-token', 'device-1'); // exactly the two arguments it always had
  });

  it('Scenario: deleting an Apple account asks Apple again first, and sends the one-time code with the request', async () => {
    const deps = setup({ stored: APPLE_SESSION });
    const app = await mount(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await app.auth().deleteAccount({ wipe: false }); });
    expect(ok).toBe(true);
    expect(deps.apple.signIn).toHaveBeenCalledTimes(1);
    expect(deps.api.deleteAccount).toHaveBeenCalledWith('apple-token', 'device-1', 'auth-code');
    expect(deps.sessions.current()).toBeNull();
    expect(app.kind()).toBe('signedOut');
  });

  it('if the reader closes Apple\'s sheet while deleting, nothing is deleted or changed and the answer is false', async () => {
    const deps = setup({ stored: APPLE_SESSION, apple: { kind: 'cancelled' } });
    const app = await mount(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await app.auth().deleteAccount(); });
    expect(ok).toBe(false);
    expect(deps.api.deleteAccount).not.toHaveBeenCalled();
    expect(deps.identity.hold).not.toHaveBeenCalled();
    expect(deps.sessions.current()).toEqual(expect.objectContaining({ token: 'apple-token' }));
    expect(app.kind()).toBe('approved');
  });

  it('an Apple account on a phone with no Apple client cannot be deleted from here, and nothing is changed', async () => {
    const deps = setup({ stored: APPLE_SESSION });
    const app = await mount(deps, false);
    let ok: boolean | undefined;
    await run(async () => { ok = await app.auth().deleteAccount(); });
    expect(ok).toBe(false);
    expect(deps.api.deleteAccount).not.toHaveBeenCalled();
  });

  it('when the server cannot delete, the answer is false and the session stays', async () => {
    const deps = setup({ stored: APPLE_SESSION, deleted: 'failed' });
    const app = await mount(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await app.auth().deleteAccount(); });
    expect(ok).toBe(false);
    expect(deps.sessions.current()).not.toBeNull();
  });

  it('signing out clears an Apple session like any other', async () => {
    const deps = setup({ stored: APPLE_SESSION });
    const app = await mount(deps);
    await run(() => app.auth().signOut());
    expect(deps.sessions.current()).toBeNull();
    expect(app.kind()).toBe('signedOut');
    expect(app.auth().provider).toBeNull();
  });
});
