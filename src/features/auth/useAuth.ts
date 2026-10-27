import { createContext, useContext } from 'react';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  /** Signed in with Google but not on the allow-list (or removed from it). */
  | { kind: 'pending' }
  /** The server could not be reached, so nothing can be decided. Not a refusal. */
  | { kind: 'connectionProblem' }
  | { kind: 'approved' };

export interface AuthContextValue {
  state: AuthState;
  /** True after a sign-in that failed for a reason other than the reader closing Google's sheet. */
  error: boolean;
  /** The short code of the signed-in reader's account (EXC-XXXX-XXXX), or null: not signed in, or a server without accounts. */
  accountRef: string | null;
  /** Opens Google's account sheet and asks the server. */
  signIn(): Promise<void>;
  /** True when Sign in with Apple is on offer: an iPhone that has it, in a build that includes it. Absent or false: no Apple button. */
  appleAvailable?: boolean;
  /** Opens Apple's sheet and asks the server. */
  signInWithApple?(): Promise<void>;
  /** Which sign-in the signed-in reader used, or null when not signed in. Deleting an Apple account asks Apple again. */
  provider?: 'google' | 'apple' | null;
  /** Asks the server again: with the stored session, or with a fresh Google token if there is none. */
  checkAgain(): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Deletes this reader's data on the server, then signs out. With `wipe`, the account's data is also removed from this phone;
   * without it, the data stays (but is not uploaded again until the reader does something new). True when it is done; false,
   * with nothing changed, when it is not.
   */
  deleteAccount(options?: { wipe?: boolean }): Promise<boolean>;
  /** The API refused a request from the open app: 403 means not approved any more, 401 means the session is gone. */
  refused(status: 401 | 403): Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** The sign-in state, or null outside an AuthProvider (the app on mock data has none, and neither do most tests). */
export const useAuth = () => useContext(AuthContext);
