import { act, create } from 'react-test-renderer';
import type { AuthApi, SessionResult, SignInResult } from '../../data/authApi';
import type { SessionStore, StoredSession } from '../../data/sessionStore';
import { AuthProvider, OFFLINE_GRACE_DAYS } from './AuthProvider';
import type { GoogleSignInClient } from './googleSignIn';
import { useAuth, type AuthContextValue } from './useAuth';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const STORED: StoredSession = { token: 'stored-token', expires_at: '2026-11-08T12:00:00.000Z', last_approved_at: daysAgo(3) };

function setup(opts: { stored?: StoredSession | null; session?: SessionResult; signIn?: SignInResult; saveFails?: boolean } = {}) {
  let saved: StoredSession | null = opts.stored === undefined ? null : opts.stored;
  const sessions: SessionStore & { current: () => StoredSession | null } = {
    current: () => saved,
    load: jest.fn(async () => saved),
    save: jest.fn(async (s: StoredSession) => { if (opts.saveFails) throw new Error('keychain full'); saved = s; }),
    clear: jest.fn(async () => { saved = null; }),
  };
  const api = {
    signIn: jest.fn(async (): Promise<SignInResult> => opts.signIn ?? { kind: 'approved', token: 'new-token', expires_at: '2026-11-08T12:00:00.000Z' }),
    signInWithApple: jest.fn(async (): Promise<SignInResult> => ({ kind: 'rejected' })), // Google readers never reach it; see AuthProviderApple.test.tsx
    checkSession: jest.fn(async (): Promise<SessionResult> => opts.session ?? { kind: 'approved', expires_at: '2026-11-08T12:00:00.000Z' }),
    signOut: jest.fn(async () => {}),
    deleteAccount: jest.fn(async (): Promise<'deleted' | 'failed'> => 'deleted'),
  } satisfies AuthApi;
  const google = {
    signIn: jest.fn(async () => ({ kind: 'ok', idToken: 'google-id-token' }) as Awaited<ReturnType<GoogleSignInClient['signIn']>>),
    signInSilently: jest.fn(async () => ({ kind: 'ok', idToken: 'silent-id-token' }) as Awaited<ReturnType<GoogleSignInClient['signInSilently']>>),
    signOut: jest.fn(async () => {}),
  } satisfies GoogleSignInClient;
  return { sessions, api, google };
}

async function mount(deps: ReturnType<typeof setup>) {
  const out: { auth: AuthContextValue | null } = { auth: null };
  function Probe() {
    out.auth = useAuth();
    return null;
  }
  await act(async () => {
    create(
      <AuthProvider api={deps.api} sessions={deps.sessions} google={deps.google} now={() => NOW}>
        <Probe />
      </AuthProvider>,
    );
  });
  await act(async () => {});
  return { out, kind: () => out.auth!.state.kind, auth: () => out.auth! };
}
const run = (fn: () => Promise<unknown> | void) => act(async () => { await fn(); });

describe('AuthProvider: when the app opens', () => {
  it('Scenario: first launch - with no session, the sign-in screen state, and the server is not asked', async () => {
    const deps = setup({ stored: null });
    const app = await mount(deps);
    expect(app.kind()).toBe('signedOut');
    expect(deps.api.checkSession).not.toHaveBeenCalled();
  });

  it('starts as "loading" until the stored session has been read', async () => {
    const deps = setup({ stored: STORED });
    let release!: () => void;
    deps.sessions.load = jest.fn(() => new Promise<StoredSession | null>((resolve) => { release = () => resolve(STORED); }));
    const out: { auth: AuthContextValue | null } = { auth: null };
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={deps.api} sessions={deps.sessions} google={deps.google} now={() => NOW}><Probe /></AuthProvider>); });
    expect(out.auth!.state.kind).toBe('loading');
    await act(async () => { release(); });
    expect(out.auth!.state.kind).toBe('approved');
  });

  it('Scenario: Returning approved reader stays signed in - approved, and the time of the approval is renewed', async () => {
    const deps = setup({ stored: STORED });
    const app = await mount(deps);
    expect(app.kind()).toBe('approved');
    expect(deps.api.checkSession).toHaveBeenCalledWith('stored-token');
    expect(deps.google.signIn).not.toHaveBeenCalled(); // no Google sheet
    expect(deps.sessions.current()).toEqual({ token: 'stored-token', expires_at: '2026-11-08T12:00:00.000Z', last_approved_at: NOW.toISOString() });
  });

  it('the server saying "pending" shows the waiting state and keeps the session', async () => {
    const deps = setup({ stored: STORED, session: { kind: 'pending' } });
    const app = await mount(deps);
    expect(app.kind()).toBe('pending');
    expect(deps.sessions.current()?.token).toBe('stored-token');
  });

  it('the server not knowing the session clears it and shows the sign-in state', async () => {
    const deps = setup({ stored: STORED, session: { kind: 'signedOut' } });
    const app = await mount(deps);
    expect(app.kind()).toBe('signedOut');
    expect(deps.sessions.current()).toBeNull();
  });

  it('Scenario: offline within 7 days - the app opens, and the approval time is not renewed', async () => {
    const deps = setup({ stored: { ...STORED, last_approved_at: daysAgo(3) }, session: { kind: 'unavailable' } });
    const app = await mount(deps);
    expect(app.kind()).toBe('approved');
    expect(deps.sessions.current()?.last_approved_at).toBe(daysAgo(3));
  });

  it('Scenario: offline after 7 days - the connection-problem state, not the app and not the waiting message', async () => {
    const deps = setup({ stored: { ...STORED, last_approved_at: daysAgo(8) }, session: { kind: 'unavailable' } });
    expect((await mount(deps)).kind()).toBe('connectionProblem');
  });

  it('the 7 days are counted exactly: just inside opens, just outside does not', async () => {
    expect(OFFLINE_GRACE_DAYS).toBe(7);
    const edge = (ms: number) => new Date(NOW.getTime() - OFFLINE_GRACE_DAYS * 86_400_000 + ms).toISOString();
    expect((await mount(setup({ stored: { ...STORED, last_approved_at: edge(1000) }, session: { kind: 'unavailable' } }))).kind()).toBe('approved');
    expect((await mount(setup({ stored: { ...STORED, last_approved_at: edge(-1000) }, session: { kind: 'unavailable' } }))).kind()).toBe('connectionProblem');
  });

  it('an approval time in the future (a clock set back) does not open the app offline', async () => {
    const deps = setup({ stored: { ...STORED, last_approved_at: new Date(NOW.getTime() + 86_400_000).toISOString() }, session: { kind: 'unavailable' } });
    expect((await mount(deps)).kind()).toBe('connectionProblem');
  });
});

describe('AuthProvider: signing in', () => {
  it('Scenario: App, approved - the server\'s answer is stored and the app opens', async () => {
    const deps = setup({ stored: null });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('approved');
    expect(deps.api.signIn).toHaveBeenCalledWith('google-id-token');
    expect(deps.sessions.current()).toEqual({ token: 'new-token', expires_at: '2026-11-08T12:00:00.000Z', last_approved_at: NOW.toISOString() });
    expect(app.auth().error).toBe(false);
  });

  it('a session that cannot be saved still lets the reader in for this run', async () => {
    const deps = setup({ stored: null, saveFails: true });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('approved');
  });

  it('the waiting state: nothing is stored', async () => {
    const deps = setup({ stored: null, signIn: { kind: 'pending' } });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('pending');
    expect(deps.sessions.save).not.toHaveBeenCalled();
  });

  it('Scenario: App, cancelled sheet - back to the sign-in state with no error', async () => {
    const deps = setup({ stored: null });
    deps.google.signIn = jest.fn(async () => ({ kind: 'cancelled' as const }));
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('signedOut');
    expect(app.auth().error).toBe(false);
    expect(deps.api.signIn).not.toHaveBeenCalled();
  });

  it('a Google failure is back to sign-in with an error flag', async () => {
    const deps = setup({ stored: null });
    deps.google.signIn = jest.fn(async () => ({ kind: 'error' as const }));
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('signedOut');
    expect(app.auth().error).toBe(true);
  });

  it('the server refusing the Google token is back to sign-in with an error flag', async () => {
    const deps = setup({ stored: null, signIn: { kind: 'rejected' } });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('signedOut');
    expect(app.auth().error).toBe(true);
  });

  it('Scenario: App, connection problem is not a refusal - an unreachable server shows connectionProblem, never pending', async () => {
    const deps = setup({ stored: null, signIn: { kind: 'unavailable' } });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('connectionProblem');
    expect(deps.sessions.save).not.toHaveBeenCalled();
  });

  it('the error flag clears on the next try', async () => {
    const deps = setup({ stored: null });
    deps.google.signIn = jest.fn(async () => ({ kind: 'error' as const }));
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.auth().error).toBe(true);
    deps.google.signIn = jest.fn(async () => ({ kind: 'cancelled' as const }));
    await run(() => app.auth().signIn());
    expect(app.auth().error).toBe(false);
  });
});

describe('AuthProvider: Check again', () => {
  it('Scenario: App, pending then approved - with no session, a silent Google sign-in and a new ask, no sheet', async () => {
    const deps = setup({ stored: null, signIn: { kind: 'pending' } });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    expect(app.kind()).toBe('pending');
    deps.api.signIn.mockResolvedValueOnce({ kind: 'approved', token: 'now-approved', expires_at: '2026-11-08T12:00:00.000Z' });
    await run(() => app.auth().checkAgain());
    expect(app.kind()).toBe('approved');
    expect(deps.google.signInSilently).toHaveBeenCalledTimes(1);
    expect(deps.google.signIn).toHaveBeenCalledTimes(1); // only the first, original sign-in showed the sheet
    expect(deps.api.signIn).toHaveBeenLastCalledWith('silent-id-token');
    expect(deps.sessions.current()?.token).toBe('now-approved');
  });

  it('still not approved stays on the waiting state', async () => {
    const deps = setup({ stored: null, signIn: { kind: 'pending' } });
    const app = await mount(deps);
    await run(() => app.auth().signIn());
    await run(() => app.auth().checkAgain());
    expect(app.kind()).toBe('pending');
  });

  it('when Google cannot sign in silently, the reader is sent back to sign in', async () => {
    for (const outcome of [{ kind: 'none' as const }, { kind: 'error' as const }]) {
      const deps = setup({ stored: null, signIn: { kind: 'pending' } });
      deps.google.signInSilently = jest.fn(async () => outcome);
      const app = await mount(deps);
      await run(() => app.auth().signIn());
      await run(() => app.auth().checkAgain());
      expect(app.kind()).toBe('signedOut');
    }
  });

  it('with a stored session (a reader removed from the list), the session is asked and Google is not', async () => {
    const deps = setup({ stored: STORED, session: { kind: 'pending' } });
    const app = await mount(deps);
    expect(app.kind()).toBe('pending');
    deps.api.checkSession.mockResolvedValueOnce({ kind: 'approved', expires_at: '2026-11-08T12:00:00.000Z' });
    await run(() => app.auth().checkAgain());
    expect(app.kind()).toBe('approved');
    expect(deps.google.signInSilently).not.toHaveBeenCalled();
  });

  it('an unreachable server on Check again is a connection problem, with no offline allowance', async () => {
    const deps = setup({ stored: STORED, session: { kind: 'pending' } });
    const app = await mount(deps);
    deps.api.checkSession.mockResolvedValueOnce({ kind: 'unavailable' });
    await run(() => app.auth().checkAgain());
    expect(app.kind()).toBe('connectionProblem');
  });

  it('Try again after a connection problem asks again from the same place', async () => {
    const deps = setup({ stored: { ...STORED, last_approved_at: daysAgo(8) }, session: { kind: 'unavailable' } });
    const app = await mount(deps);
    expect(app.kind()).toBe('connectionProblem');
    deps.api.checkSession.mockResolvedValueOnce({ kind: 'approved', expires_at: '2026-11-08T12:00:00.000Z' });
    await run(() => app.auth().checkAgain());
    expect(app.kind()).toBe('approved');
  });
});

describe('AuthProvider: while the app is open', () => {
  it('Scenario: App, removed while open - a 403 shows the waiting state and keeps the session', async () => {
    const deps = setup({ stored: STORED });
    const app = await mount(deps);
    expect(app.kind()).toBe('approved');
    await run(() => app.auth().refused(403));
    expect(app.kind()).toBe('pending');
    expect(deps.sessions.current()?.token).toBe('stored-token');
  });

  it('a 401 clears the session and shows the sign-in state', async () => {
    const deps = setup({ stored: STORED });
    const app = await mount(deps);
    await run(() => app.auth().refused(401));
    expect(app.kind()).toBe('signedOut');
    expect(deps.sessions.current()).toBeNull();
  });
});

describe('AuthProvider: signing out', () => {
  it('Scenario: Sign out - the server is told once, the session and Google account are cleared, and the sign-in state shows', async () => {
    const deps = setup({ stored: STORED });
    const app = await mount(deps);
    await run(() => app.auth().signOut());
    expect(app.kind()).toBe('signedOut');
    expect(deps.api.signOut).toHaveBeenCalledTimes(1);
    expect(deps.api.signOut).toHaveBeenCalledWith('stored-token');
    expect(deps.sessions.clear).toHaveBeenCalled();
    expect(deps.google.signOut).toHaveBeenCalled();
    expect(deps.sessions.current()).toBeNull();
  });

  it('works when the server cannot be reached', async () => {
    const deps = setup({ stored: STORED });
    deps.api.signOut = jest.fn(async () => { throw new Error('offline'); });
    const app = await mount(deps);
    await run(() => app.auth().signOut());
    expect(app.kind()).toBe('signedOut');
    expect(deps.sessions.current()).toBeNull();
  });

  it('an answer that arrives after signing out cannot bring the reader back in', async () => {
    const deps = setup({ stored: STORED });
    let answer!: (r: SessionResult) => void;
    deps.api.checkSession = jest.fn(() => new Promise<SessionResult>((resolve) => { answer = resolve; }));
    const out: { auth: AuthContextValue | null } = { auth: null };
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={deps.api} sessions={deps.sessions} google={deps.google} now={() => NOW}><Probe /></AuthProvider>); });
    await act(async () => {});
    await run(() => out.auth!.signOut());
    await act(async () => { answer({ kind: 'approved', expires_at: '2026-11-08T12:00:00.000Z' }); });
    expect(out.auth!.state.kind).toBe('signedOut');
  });
});

describe('useAuth', () => {
  it('is null outside the provider, so a screen can leave the sign-in parts out', async () => {
    let seen: AuthContextValue | null | undefined;
    function Probe() { seen = useAuth(); return null; }
    await act(async () => { create(<Probe />); });
    expect(seen).toBeNull();
  });
});

describe('AuthProvider: deleting the account', () => {
  const identity = () => {
    const calls: string[] = [];
    const release = jest.fn(() => { calls.push('release'); });
    return {
      calls,
      release,
      deviceId: jest.fn(async () => 'device-1'),
      hold: jest.fn(async () => { calls.push('hold'); return release; }),
      forget: jest.fn(async () => { calls.push('forget'); }),
    };
  };
  async function mountWith(deps: ReturnType<typeof setup> & { api: { deleteAccount: jest.Mock } }, id = identity()) {
    const out: { auth: AuthContextValue | null } = { auth: null };
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={deps.api as unknown as AuthApi} sessions={deps.sessions} google={deps.google} identity={id} now={() => NOW}><Probe /></AuthProvider>); });
    await act(async () => {});
    return { out, id };
  }
  const withDelete = (result: 'deleted' | 'failed') => {
    const deps = setup({ stored: STORED });
    return { ...deps, api: { ...deps.api, deleteAccount: jest.fn(async () => result) } };
  };

  it('Scenario: Delete succeeds - the server is asked with the token and this device\'s id, then the leaderboard identity, the session and the Google account are cleared and the reader is signed out', async () => {
    const deps = withDelete('deleted');
    const { out, id } = await mountWith(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await out.auth!.deleteAccount(); });
    expect(ok).toBe(true);
    expect(deps.api.deleteAccount).toHaveBeenCalledWith('stored-token', 'device-1');
    expect(id.forget).toHaveBeenCalledTimes(1);
    expect(id.calls).toEqual(['hold', 'forget', 'release']); // sending is stopped before the server is asked, and resumes only after the identity is gone
    expect(deps.sessions.current()).toBeNull();
    expect(deps.google.signOut).toHaveBeenCalledTimes(1);
    expect(out.auth!.state.kind).toBe('signedOut');
  });

  it('Scenario: Delete fails - nothing is cleared, the reader stays signed in, and the answer is false so the screen can say so', async () => {
    const deps = withDelete('failed');
    const { out, id } = await mountWith(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await out.auth!.deleteAccount(); });
    expect(ok).toBe(false);
    expect(id.forget).not.toHaveBeenCalled();
    expect(id.calls).toEqual(['hold', 'release']); // sending resumes: nothing was deleted, so queued verifications still go out
    expect(deps.sessions.current()?.token).toBe(STORED.token); // still stored (the launch check refreshed its approval date)
    expect(deps.google.signOut).not.toHaveBeenCalled();
    expect(out.auth!.state.kind).toBe('approved');
  });

  it('is false, and asks nothing, when there is no stored session', async () => {
    const deps = withDelete('deleted');
    deps.sessions.load = jest.fn(async () => null);
    const { out } = await mountWith(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await out.auth!.deleteAccount(); });
    expect(ok).toBe(false);
    expect(deps.api.deleteAccount).not.toHaveBeenCalled();
  });

  it('sending is resumed even when the request itself throws', async () => {
    const deps = withDelete('deleted');
    deps.api.deleteAccount.mockRejectedValueOnce(new Error('boom'));
    const { out, id } = await mountWith(deps);
    let ok: boolean | undefined;
    await run(async () => { ok = await out.auth!.deleteAccount().catch(() => false); });
    expect(ok).toBe(false);
    expect(id.release).toHaveBeenCalledTimes(1);
  });
});

describe('AuthProvider: accounts on the phone', () => {
  const REF_A = 'EXC-7K4Q-92M3';
  const REF_B = 'EXC-0000-ABCD';
  const approvedWith = (ref?: string, token = 'new-token'): SignInResult => ({ kind: 'approved', token, expires_at: '2026-11-08T12:00:00.000Z', ...(ref ? { account_ref: ref } : {}) });

  async function mountWithAccount(deps: ReturnType<typeof setup>, activate?: (ref: string | null) => Promise<void>) {
    const out: { auth: AuthContextValue | null } = { auth: null };
    const seen: Array<{ ref: string | null; stateWhenCalled: string }> = [];
    const account = { activate: jest.fn(async (ref: string | null) => { seen.push({ ref, stateWhenCalled: out.auth?.state.kind ?? 'none' }); await activate?.(ref); }) };
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={deps.api} sessions={deps.sessions} google={deps.google} account={account} now={() => NOW}><Probe /></AuthProvider>); });
    await act(async () => {});
    return { out, account, seen, kind: () => out.auth!.state.kind, ref: () => out.auth!.accountRef };
  }

  it('Scenario: Signing in - the phone is pointed at the account before the app appears, and the reference is kept with the session', async () => {
    const deps = setup({ stored: null, signIn: approvedWith(REF_A) });
    const app = await mountWithAccount(deps);
    await run(() => app.out.auth!.signIn());
    expect(app.kind()).toBe('approved');
    expect(app.ref()).toBe(REF_A);
    expect(app.seen.filter((s) => s.ref === REF_A)).toEqual([{ ref: REF_A, stateWhenCalled: 'signedOut' }]); // not yet 'approved': nothing of the app is on screen
    expect(deps.sessions.current()?.account_ref).toBe(REF_A);
  });

  it('Scenario: Opening the app with a session - the server answers with the account and the phone is pointed at it', async () => {
    const deps = setup({ stored: { ...STORED, account_ref: REF_A }, session: { kind: 'approved', expires_at: STORED.expires_at, account_ref: REF_A } });
    const app = await mountWithAccount(deps);
    expect(app.kind()).toBe('approved');
    expect(app.ref()).toBe(REF_A);
    expect(app.seen[0]).toEqual({ ref: REF_A, stateWhenCalled: 'loading' });
  });

  it('without a connection, inside the grace period, the account stored with the session is used', async () => {
    const deps = setup({ stored: { ...STORED, account_ref: REF_A }, session: { kind: 'unavailable' } });
    const app = await mountWithAccount(deps);
    expect(app.kind()).toBe('approved');
    expect(app.ref()).toBe(REF_A);
  });

  it('Scenario: A session from before accounts is renewed silently, once, and the phone then follows the account', async () => {
    const deps = setup({ stored: { ...STORED }, session: { kind: 'approved', expires_at: STORED.expires_at }, signIn: approvedWith(REF_A, 'renewed-token') });
    const app = await mountWithAccount(deps);
    expect(deps.google.signInSilently).toHaveBeenCalledTimes(1);
    expect(deps.api.signIn).toHaveBeenCalledWith('silent-id-token');
    expect(app.kind()).toBe('approved');
    expect(app.ref()).toBe(REF_A);
    expect(deps.sessions.current()).toMatchObject({ token: 'renewed-token', account_ref: REF_A });
  });

  it('if the renewal cannot be done (no silent sign-in, or the server cannot be reached) the reader still gets in, with the data as it was before accounts', async () => {
    for (const variant of ['no-silent', 'server-down'] as const) {
      const deps = setup({ stored: { ...STORED }, session: { kind: 'approved', expires_at: STORED.expires_at }, signIn: variant === 'server-down' ? { kind: 'unavailable' } : approvedWith(REF_A) });
      if (variant === 'no-silent') deps.google.signInSilently.mockResolvedValue({ kind: 'none' } as never);
      const app = await mountWithAccount(deps);
      expect(app.kind()).toBe('approved');
      expect(app.ref()).toBeNull();
      expect(deps.sessions.current()?.token).toBe(STORED.token); // the old session is kept
    }
  });

  it('Scenario: A different Google account signs in on the same phone - the phone switches to that account, and back again', async () => {
    const deps = setup({ stored: null });
    deps.api.signIn.mockResolvedValueOnce(approvedWith(REF_A)).mockResolvedValueOnce(approvedWith(REF_B)).mockResolvedValueOnce(approvedWith(REF_A));
    const app = await mountWithAccount(deps);
    await run(() => app.out.auth!.signIn());
    expect(app.ref()).toBe(REF_A);
    await run(() => app.out.auth!.signOut());
    expect(app.kind()).toBe('signedOut');
    await run(() => app.out.auth!.signIn());
    expect(app.ref()).toBe(REF_B);
    await run(() => app.out.auth!.signOut());
    await run(() => app.out.auth!.signIn());
    expect(app.ref()).toBe(REF_A);
    expect(app.seen.map((s) => s.ref)).toEqual([null, REF_A, null, REF_B, null, REF_A]);
  });

  it('every way out of the app points the phone at no account: signing out, a waiting screen, a refused session', async () => {
    const deps = setup({ stored: null });
    deps.api.signIn.mockResolvedValueOnce(approvedWith(REF_A)).mockResolvedValueOnce({ kind: 'pending' }).mockResolvedValueOnce(approvedWith(REF_A));
    const app = await mountWithAccount(deps);
    await run(() => app.out.auth!.signIn());
    await run(() => app.out.auth!.signOut());
    await run(() => app.out.auth!.signIn()); // pending
    expect(app.kind()).toBe('pending');
    expect(app.seen[app.seen.length - 1].ref).toBeNull();
    await run(() => app.out.auth!.signIn()); // approved again
    await run(() => app.out.auth!.refused(401));
    expect(app.kind()).toBe('signedOut');
    expect(app.seen[app.seen.length - 1].ref).toBeNull();
  });

  it('if pointing the phone at the account fails, the reader is still let in', async () => {
    const deps = setup({ stored: null, signIn: approvedWith(REF_A) });
    const app = await mountWithAccount(deps, async (ref) => { if (ref) throw new Error('storage full'); });
    await run(() => app.out.auth!.signIn());
    expect(app.kind()).toBe('approved');
  });

  it('deleting the account points the phone at no account', async () => {
    const deps = withDeleteResult('deleted', { ...STORED, account_ref: REF_A });
    const out: { auth: AuthContextValue | null } = { auth: null };
    const calls: Array<string | null> = [];
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={deps.api as unknown as AuthApi} sessions={deps.sessions} google={deps.google} identity={{ deviceId: async () => 'd', hold: async () => () => {}, forget: async () => {} }} account={{ activate: async (r) => { calls.push(r); } }} now={() => NOW}><Probe /></AuthProvider>); });
    await act(async () => {});
    await run(() => out.auth!.deleteAccount());
    expect(out.auth!.state.kind).toBe('signedOut');
    expect(calls[calls.length - 1]).toBeNull();
  });

  function withDeleteResult(result: 'deleted' | 'failed', stored: StoredSession) {
    const deps = setup({ stored, session: { kind: 'approved', expires_at: stored.expires_at, account_ref: stored.account_ref } });
    return { ...deps, api: { ...deps.api, deleteAccount: jest.fn(async () => result) } };
  }
});

describe('AuthProvider: deleting the account, and the data on the phone', () => {
  const REF = 'EXC-7K4Q-92M3';
  async function mountDelete(result: 'deleted' | 'failed', wipeFails = false) {
    const base = setup({ stored: { ...STORED, account_ref: REF }, session: { kind: 'approved', expires_at: STORED.expires_at, account_ref: REF } });
    const api = { ...base.api, deleteAccount: jest.fn(async () => result) };
    const calls: string[] = [];
    const identity = { deviceId: async () => 'd', hold: async () => () => {}, forget: jest.fn(async () => { calls.push('forget'); }) };
    const account = { activate: jest.fn(async (r: string | null) => { calls.push(r === null ? 'activate(null)' : 'activate(ref)'); }), wipe: jest.fn(async () => { calls.push('wipe'); if (wipeFails) throw new Error('storage'); }) };
    const out: { auth: AuthContextValue | null } = { auth: null };
    function Probe() { out.auth = useAuth(); return null; }
    await act(async () => { create(<AuthProvider api={api as unknown as AuthApi} sessions={base.sessions} google={base.google} identity={identity} account={account} now={() => NOW}><Probe /></AuthProvider>); });
    await act(async () => {});
    calls.length = 0;
    return { out, account, identity, calls, base };
  }

  it('Scenario: Delete and keep (the default) - the data stays on the phone, the phone forgets what the server knew, and the reader is signed out', async () => {
    const app = await mountDelete('deleted');
    let ok: boolean | undefined;
    await run(async () => { ok = await app.out.auth!.deleteAccount(); });
    expect(ok).toBe(true);
    expect(app.account.wipe).not.toHaveBeenCalled();
    expect(app.identity.forget).toHaveBeenCalledTimes(1);
    expect(app.out.auth!.state.kind).toBe('signedOut');
  });

  it('Scenario: Delete and wipe - the account\'s data is also removed from the phone, after the server has deleted and before the phone leaves the account', async () => {
    const app = await mountDelete('deleted');
    let ok: boolean | undefined;
    await run(async () => { ok = await app.out.auth!.deleteAccount({ wipe: true }); });
    expect(ok).toBe(true);
    expect(app.calls).toEqual(['forget', 'wipe', 'activate(null)']);
    expect(app.out.auth!.state.kind).toBe('signedOut');
  });

  it('if the server could not delete, nothing is wiped and the reader stays signed in', async () => {
    const app = await mountDelete('failed');
    let ok: boolean | undefined;
    await run(async () => { ok = await app.out.auth!.deleteAccount({ wipe: true }); });
    expect(ok).toBe(false);
    expect(app.account.wipe).not.toHaveBeenCalled();
    expect(app.out.auth!.state.kind).toBe('approved');
  });

  it('a wipe that fails does not stop the sign-out: the server\'s data is gone either way', async () => {
    const app = await mountDelete('deleted', true);
    let ok: boolean | undefined;
    await run(async () => { ok = await app.out.auth!.deleteAccount({ wipe: true }); });
    expect(ok).toBe(true);
    expect(app.out.auth!.state.kind).toBe('signedOut');
  });
});
