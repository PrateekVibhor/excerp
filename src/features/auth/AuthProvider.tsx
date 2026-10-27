import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthApi } from '../../data/authApi';
import type { SessionStore, StoredSession } from '../../data/sessionStore';
import type { AppleSignInClient } from './appleSignIn';
import type { GoogleSignInClient } from './googleSignIn';
import { AuthContext, type AuthContextValue, type AuthState } from './useAuth';

/** How long the app opens without a connection after the server last said "approved". */
export const OFFLINE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Holds the sign-in state and runs the rules of spec 11. The server decides who is approved; this only follows its
 * answers. An answer that arrives after a newer action (a sign-out, a second try) is ignored.
 */
export function AuthProvider({
  api,
  sessions,
  google,
  apple,
  identity,
  account,
  now = () => new Date(),
  children,
}: {
  api: AuthApi;
  sessions: SessionStore;
  google: GoogleSignInClient;
  /** Sign in with Apple, on an iPhone in a build that includes it. Left out, there is no Apple button. */
  apple?: AppleSignInClient;
  /** This device's leaderboard identity: the id the server is told to delete, and a way to forget it afterwards. */
  identity?: { deviceId(): Promise<string>; hold(): Promise<() => void>; forget(): Promise<void> };
  /**
   * Points the phone's storage at an account (or at none, with null). Called before the app is shown, so every screen
   * opens on that account's data, and with null whenever the app is left. Left out, nothing is scoped (mock data).
   */
  account?: { activate(ref: string | null): Promise<void>; /** Removes the active account's data from the phone. */ wipe?(): Promise<void> };
  now?: () => Date;
  children: ReactNode;
}) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  const [error, setError] = useState(false);
  const [accountRef, setAccountRef] = useState<string | null>(null);
  const [provider, setProvider] = useState<'google' | 'apple' | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const latest = useRef(0);
  const deps = useRef({ api, sessions, google, apple, identity, account, now });
  deps.current = { api, sessions, google, apple, identity, account, now };

  const start = () => ++latest.current;
  const show = (attempt: number, next: AuthState, failed = false, ref: string | null = null) => {
    if (attempt !== latest.current) return;
    setError(failed);
    setAccountRef(next.kind === 'approved' ? ref : null);
    if (next.kind !== 'approved') setProvider(null);
    setState(next);
    // Left the app (signed out, waiting, refused): the phone is pointed at no account, so nothing of one can be seen.
    if (next.kind === 'signedOut' || next.kind === 'pending') void point(null);
  };
  /** Pointing the phone at an account can fail (storage); the reader is let in anyway, and the next launch tries again. */
  const point = async (ref: string | null) => {
    try {
      await deps.current.account?.activate(ref);
    } catch {
      // see above
    }
  };
  /** Approved: the phone is pointed at the reader's account first, so the app opens on that account's data. */
  const enter = async (attempt: number, ref: string | null) => {
    if (attempt !== latest.current) return;
    await point(ref);
    show(attempt, { kind: 'approved' }, false, ref);
  };

  const withinGrace = (stored: StoredSession) => {
    const age = deps.current.now().getTime() - Date.parse(stored.last_approved_at);
    return age >= 0 && age <= OFFLINE_GRACE_DAYS * DAY_MS; // a time in the future (a clock set back) earns nothing
  };

  /**
   * Signs in again, silently, to get a session that belongs to an account. Null when that cannot be done right now
   * (no silent sign-in, no connection, not approved): the old session then carries on as it was.
   */
  const renewForAccount = async (attempt: number): Promise<StoredSession | null> => {
    const outcome = await deps.current.google.signInSilently();
    if (attempt !== latest.current || outcome.kind !== 'ok') return null;
    const result = await deps.current.api.signIn(outcome.idToken);
    if (attempt !== latest.current || result.kind !== 'approved' || !result.account_ref) return null;
    return { token: result.token, expires_at: result.expires_at, last_approved_at: deps.current.now().toISOString(), account_ref: result.account_ref };
  };

  /** Asks the server about the stored session. `allowOffline` lets a recent approval stand when it cannot be reached. */
  const checkStored = useCallback(async (attempt: number, stored: StoredSession, allowOffline: boolean) => {
    const result = await deps.current.api.checkSession(stored.token);
    if (attempt !== latest.current) return;
    switch (result.kind) {
      case 'approved': {
        let current = stored;
        let ref = result.account_ref ?? null;
        if (ref === null && deps.current.account && stored.provider !== 'apple') {
          // A session from before accounts (or a server without them): one silent sign-in makes the account and a new session.
          const renewed = await renewForAccount(attempt);
          if (attempt !== latest.current) return;
          if (renewed) {
            current = renewed;
            ref = renewed.account_ref ?? null;
          }
        }
        try {
          await deps.current.sessions.save({ ...current, ...(ref ? { account_ref: ref } : {}), last_approved_at: deps.current.now().toISOString() });
        } catch {
          // the reader is in either way; the next launch asks the server again
        }
        if (attempt === latest.current) setProvider(stored.provider ?? 'google');
        return enter(attempt, ref);
      }
      case 'pending':
        return show(attempt, { kind: 'pending' });
      case 'signedOut':
        await deps.current.sessions.clear();
        return show(attempt, { kind: 'signedOut' });
      case 'unavailable':
        if (allowOffline && withinGrace(stored)) {
          setProvider(stored.provider ?? 'google');
          return enter(attempt, stored.account_ref ?? null);
        }
        return show(attempt, { kind: 'connectionProblem' });
    }
  }, []);

  /** Sends a Google token (or, with `apple`, an Apple identity token and its raw nonce) to the server and acts on the answer. */
  const completeSignIn = useCallback(async (attempt: number, idToken: string, apple?: { nonce: string }) => {
    const result = apple ? await deps.current.api.signInWithApple(idToken, apple.nonce) : await deps.current.api.signIn(idToken);
    if (attempt !== latest.current) return;
    switch (result.kind) {
      case 'approved':
        try {
          await deps.current.sessions.save({ token: result.token, expires_at: result.expires_at, last_approved_at: deps.current.now().toISOString(), ...(result.account_ref ? { account_ref: result.account_ref } : {}), ...(apple ? { provider: 'apple' as const } : {}) });
        } catch {
          // the session could not be kept, so the reader is asked again next launch, but this run goes on
        }
        setProvider(apple ? 'apple' : 'google');
        return enter(attempt, result.account_ref ?? null);
      case 'pending':
        return show(attempt, { kind: 'pending' });
      case 'rejected':
        return show(attempt, { kind: 'signedOut' }, true);
      case 'unavailable':
        return show(attempt, { kind: 'connectionProblem' });
    }
  }, []);

  useEffect(() => {
    let current = true;
    void apple?.isAvailable().then((yes) => current && setAppleAvailable(yes)).catch(() => {});
    return () => {
      current = false;
    };
  }, [apple]);

  useEffect(() => {
    const attempt = start();
    (async () => {
      const stored = await deps.current.sessions.load();
      if (attempt !== latest.current) return;
      if (!stored) return show(attempt, { kind: 'signedOut' });
      await checkStored(attempt, stored, true);
    })();
    return () => {
      latest.current++;
    };
  }, [checkStored]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      error,
      accountRef,
      provider,
      appleAvailable,

      async signInWithApple() {
        if (!deps.current.apple) return;
        const attempt = start();
        setError(false);
        const outcome = await deps.current.apple.signIn();
        if (attempt !== latest.current) return;
        if (outcome.kind === 'cancelled') return show(attempt, { kind: 'signedOut' }); // closing the sheet is not an error
        if (outcome.kind === 'error') return show(attempt, { kind: 'signedOut' }, true);
        await completeSignIn(attempt, outcome.identityToken, { nonce: outcome.nonce });
      },

      async signIn() {
        const attempt = start();
        setError(false);
        const outcome = await deps.current.google.signIn();
        if (attempt !== latest.current) return;
        if (outcome.kind === 'cancelled') return show(attempt, { kind: 'signedOut' }); // closing the sheet is not an error
        if (outcome.kind === 'error') return show(attempt, { kind: 'signedOut' }, true);
        await completeSignIn(attempt, outcome.idToken);
      },

      async checkAgain() {
        const attempt = start();
        const stored = await deps.current.sessions.load();
        if (attempt !== latest.current) return;
        if (stored) return checkStored(attempt, stored, false);
        const outcome = await deps.current.google.signInSilently(); // a fresh token for the same account, with no sheet
        if (attempt !== latest.current) return;
        if (outcome.kind !== 'ok') return show(attempt, { kind: 'signedOut' });
        await completeSignIn(attempt, outcome.idToken);
      },

      async signOut() {
        const attempt = start();
        const stored = await deps.current.sessions.load();
        if (stored) void Promise.resolve(deps.current.api.signOut(stored.token)).catch(() => {}); // best effort; the screen does not wait for it
        await deps.current.sessions.clear();
        await deps.current.google.signOut();
        show(attempt, { kind: 'signedOut' });
      },

      async deleteAccount(options) {
        const { api, sessions, google, apple, identity } = deps.current;
        const stored = await sessions.load();
        if (!stored || !identity) return false;
        // An Apple account is deleted with Apple's say-so: the reader signs in with Apple again, and the one-time code that gives goes to the server, which uses it to revoke
        // Apple access. Closing the sheet leaves everything as it was. Nothing of Apple's is kept.
        let appleCode: string | undefined;
        if (stored.provider === 'apple') {
          const again = await apple?.signIn();
          if (again?.kind !== 'ok') return false;
          appleCode = again.authorizationCode;
        }
        const attempt = start();
        // Sending to the leaderboard is stopped first, and resumes only once this phone has forgotten its old id, so
        // no queued verification can reach the server after the delete and bring the entry back.
        const release = await identity.hold();
        try {
          const deviceId = await identity.deviceId();
          if ((appleCode ? await api.deleteAccount(stored.token, deviceId, appleCode) : await api.deleteAccount(stored.token, deviceId)) !== 'deleted') return false;
          // The server's copy is gone; what follows only tidies this phone, so none of it may stop the sign-out.
          await identity.forget().catch(() => {});
        } finally {
          release();
        }
        // The reader chose whether the account's data also leaves this phone. The server's data is gone either way.
        if (options?.wipe) await deps.current.account?.wipe?.().catch(() => {});
        await sessions.clear();
        await google.signOut();
        show(attempt, { kind: 'signedOut' });
        return true;
      },

      async refused(status) {
        const attempt = start();
        if (status === 403) return show(attempt, { kind: 'pending' });
        await deps.current.sessions.clear();
        show(attempt, { kind: 'signedOut' });
      },
    }),
    [state, error, accountRef, provider, appleAvailable, checkStored, completeSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
