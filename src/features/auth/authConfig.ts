import { Platform } from 'react-native';
import { createAuthApi, type AuthApi } from '../../data/authApi';
import { createSessionStore, type SessionStore } from '../../data/sessionStore';
import { createAppleSignInClient, type AppleSignInClient } from './appleSignIn';
import { createGoogleSignInClient, type GoogleSignInClient } from './googleSignIn';

export interface AuthDeps {
  api: AuthApi;
  sessions: SessionStore;
  google: GoogleSignInClient;
  /** Only on an iPhone build: Apple's rule asks for it beside Google's sign-in. Its button shows only where the phone offers it. */
  apple?: AppleSignInClient;
}

/**
 * What the sign-in gate runs on, or null when there is no gate: on mock data there is no server, and a build without
 * a Google web client id has no way to sign in. Both are fixed when the app is built, never chosen by a reader.
 */
export function createAuthDeps(env: { source?: string; apiUrl?: string; webClientId?: string; iosClientId?: string; e2e?: string; ios?: boolean }): AuthDeps | null {
  // The end-to-end test build (EXPO_PUBLIC_E2E exactly "true") signs in through a stand-in for Google's sheet and needs no web client id.
  // The stand-in is required only on this path, so a build without the flag never loads it.
  const standIn = env.e2e === 'true';
  if (env.source !== 'api' || !env.apiUrl || (!env.webClientId && !standIn)) return null;
  return {
    api: createAuthApi(env.apiUrl),
    sessions: createSessionStore(),
    google: standIn
      ? (require('./fakeGoogle') as typeof import('./fakeGoogle')).createFakeGoogleClient()
      : createGoogleSignInClient({ webClientId: env.webClientId!, iosClientId: env.iosClientId || undefined }),
    ...(env.ios && !standIn ? { apple: createAppleSignInClient() } : {}),
  };
}

/** True only in the end-to-end test build: the root layout then mounts the stand-in's sheet. Fixed when the app is built. */
export const e2eEnabled = process.env.EXPO_PUBLIC_E2E === 'true';

// Expo inlines these at build time, so they must be read as literal property accesses.
export const authDeps = createAuthDeps({
  source: process.env.EXPO_PUBLIC_DATA_SOURCE,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  e2e: process.env.EXPO_PUBLIC_E2E,
  ios: Platform.OS === 'ios',
});
