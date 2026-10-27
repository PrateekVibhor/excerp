import { Platform } from 'react-native';

export type AppleSignInOutcome = { kind: 'ok'; identityToken: string; authorizationCode: string; nonce: string } | { kind: 'cancelled' } | { kind: 'error' };

/** What the app needs from Sign in with Apple. The native libraries sit behind this, so everything else is tested with a fake. */
export interface AppleSignInClient {
  /** True only on an iPhone that offers Sign in with Apple. Never rejects. */
  isAvailable(): Promise<boolean>;
  /**
   * Shows Apple's sheet. The token Apple gives is made for a nonce: Apple is given the hash and the server the raw value, so a token cannot be replayed from another sign-in.
   * The authorization code is what the server needs to revoke Apple access when the account is deleted; it is one-time, and the app keeps nothing of Apple's.
   */
  signIn(): Promise<AppleSignInOutcome>;
}

/** The native libraries are loaded only when first used: they exist only in a build that includes them, never in unit tests that do not mock them. */
export function createAppleSignInClient(): AppleSignInClient {
  const apple = () => require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  const crypto = () => require('expo-crypto') as typeof import('expo-crypto');
  return {
    async isAvailable() {
      if (Platform.OS !== 'ios') return false;
      try {
        return await apple().isAvailableAsync();
      } catch {
        return false;
      }
    },

    async signIn() {
      try {
        const nonce = [...crypto().getRandomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const hashed = await crypto().digestStringAsync(crypto().CryptoDigestAlgorithm.SHA256, nonce);
        // Only the email is asked for. Excerp has its own display name and never uses the name Apple holds.
        const result = await apple().signInAsync({ requestedScopes: [apple().AppleAuthenticationScope.EMAIL], nonce: hashed });
        const { identityToken, authorizationCode } = result;
        return typeof identityToken === 'string' && identityToken !== '' && typeof authorizationCode === 'string' && authorizationCode !== '' ? { kind: 'ok', identityToken, authorizationCode, nonce } : { kind: 'error' };
      } catch (error) {
        // Failure details can name the account, so none is passed on.
        return (error as { code?: unknown })?.code === 'ERR_REQUEST_CANCELED' ? { kind: 'cancelled' } : { kind: 'error' };
      }
    },
  };
}
