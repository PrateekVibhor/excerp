import { ACCOUNT_REF } from './accountRef';

export type SignInResult =
  | { kind: 'approved'; token: string; expires_at: string; /** The short code of the reader's account; absent from a server without accounts. */ account_ref?: string }
  | { kind: 'pending' }
  /** The server refused the Google token itself. */
  | { kind: 'rejected' }
  /** No answer worth trusting: no network, a timeout, 429, 5xx or a body that is not what the server sends. */
  | { kind: 'unavailable' };

export type SessionResult = { kind: 'approved'; expires_at: string; account_ref?: string } | { kind: 'pending' } | { kind: 'signedOut' } | { kind: 'unavailable' };

export interface AuthApi {
  signIn(idToken: string): Promise<SignInResult>;
  /** Sign in with Apple: the identity token, and the raw nonce whose hash Apple put in it. Answers exactly as signIn does. */
  signInWithApple(identityToken: string, nonce: string): Promise<SignInResult>;
  checkSession(token: string): Promise<SessionResult>;
  /** Best effort: never rejects. */
  signOut(token: string): Promise<void>;
  /**
   * 'deleted' only when the server said 204; every other outcome, including no answer, is 'failed'. Never rejects. An Apple reader's request carries the one-time code
   * from signing in with Apple again, which the server uses to revoke Apple access.
   */
  deleteAccount(token: string, deviceId: string, appleAuthorizationCode?: string): Promise<'deleted' | 'failed'>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 10_000;
const text = (v: unknown): v is string => typeof v === 'string' && v !== '';
/** The account reference, only if it is in the server's format: it becomes part of storage keys. */
const ref = (v: unknown): { account_ref?: string } => (typeof v === 'string' && ACCOUNT_REF.test(v) ? { account_ref: v } : {});

/**
 * The sign-in endpoints of the API (spec 11). Anything it cannot be sure of is "unavailable", so a failure is never
 * mistaken for an approval or for a refusal. Tokens are never logged.
 */
export function createAuthApi(baseUrl: string, fetchFn: Fetch = fetch, timeoutMs = TIMEOUT_MS): AuthApi {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(`${root}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = async (res: Response): Promise<Record<string, unknown> | null> => {
    const value: unknown = await res.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };

  /** Sends a provider's token and acts on the answer, the same for both. */
  async function exchange(path: string, payload: Record<string, string>): Promise<SignInResult> {
    try {
      const res = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.status === 401 || res.status === 400) return { kind: 'rejected' };
      if (res.status !== 200) return { kind: 'unavailable' };
      const b = await body(res);
      if (b?.status === 'pending') return { kind: 'pending' };
      if (b?.status === 'approved' && text(b.session_token) && text(b.expires_at)) return { kind: 'approved', token: b.session_token, expires_at: b.expires_at, ...ref(b.account_ref) };
      return { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    signIn: (idToken) => exchange('/auth/google', { id_token: idToken }),
    signInWithApple: (identityToken, nonce) => exchange('/auth/apple', { identity_token: identityToken, nonce }),

    async checkSession(token) {
      try {
        const res = await request('/auth/session', { method: 'GET', headers: bearer(token) });
        if (res.status === 403) return { kind: 'pending' };
        if (res.status === 401) return { kind: 'signedOut' };
        if (res.status !== 200) return { kind: 'unavailable' };
        const b = await body(res);
        return b?.status === 'approved' && text(b.expires_at) ? { kind: 'approved', expires_at: b.expires_at, ...ref(b.account_ref) } : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async signOut(token) {
      try {
        await request('/auth/signout', { method: 'POST', headers: bearer(token) });
      } catch {
        // the session also ends on the device; the server's copy expires by itself
      }
    },

    async deleteAccount(token, deviceId, appleAuthorizationCode) {
      try {
        const res = await request('/auth/delete-account', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: deviceId, ...(appleAuthorizationCode ? { apple_authorization_code: appleAuthorizationCode } : {}) }) });
        return res.status === 204 ? 'deleted' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}
