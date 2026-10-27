export type GoogleSignInOutcome = { kind: 'ok'; idToken: string } | { kind: 'cancelled' } | { kind: 'error' };
export type GoogleSilentOutcome = { kind: 'ok'; idToken: string } | { kind: 'none' } | { kind: 'error' };

/** What the app needs from Google sign-in. The native library sits behind this, so everything else is tested with a fake. */
export interface GoogleSignInClient {
  /** Shows Google's account sheet. */
  signIn(): Promise<GoogleSignInOutcome>;
  /** A fresh ID token for the last account, with no sheet. */
  signInSilently(): Promise<GoogleSilentOutcome>;
  /** Never rejects. */
  signOut(): Promise<void>;
}

/**
 * The native library, loaded only when it is first used: it exists only in an EAS development build, never in Expo Go
 * or in unit tests. `webClientId` is what makes the ID token one the server will accept.
 */
export function createGoogleSignInClient({ webClientId, iosClientId }: { webClientId: string; iosClientId?: string }): GoogleSignInClient {
  let google: typeof import('@react-native-google-signin/google-signin').GoogleSignin | undefined;
  const lib = () => {
    if (!google) {
      google = (require('@react-native-google-signin/google-signin') as typeof import('@react-native-google-signin/google-signin')).GoogleSignin;
      google.configure({ webClientId, iosClientId });
    }
    return google;
  };
  // Failure details from the library can name the app's client or the account, so none is passed on.
  const cancelled = (error: unknown) => (error as { code?: unknown })?.code === 'SIGN_IN_CANCELLED';

  return {
    async signIn() {
      try {
        const result = await lib().signIn();
        if (result.type === 'cancelled') return { kind: 'cancelled' };
        const idToken = result.data.idToken;
        return typeof idToken === 'string' && idToken !== '' ? { kind: 'ok', idToken } : { kind: 'error' };
      } catch (error) {
        return cancelled(error) ? { kind: 'cancelled' } : { kind: 'error' };
      }
    },

    async signInSilently() {
      try {
        const result = await lib().signInSilently();
        if (result.type !== 'success') return { kind: 'none' };
        const idToken = result.data.idToken;
        return typeof idToken === 'string' && idToken !== '' ? { kind: 'ok', idToken } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    },

    async signOut() {
      try {
        await lib().signOut();
      } catch {
        // signing out of the app does not depend on it
      }
    },
  };
}
