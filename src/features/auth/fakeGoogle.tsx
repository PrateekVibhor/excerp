import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, statePanel, typography } from '../../theme';
import { StateButton } from '../feed/FeedStatus';
import type { GoogleSignInClient, GoogleSignInOutcome, GoogleSilentOutcome } from './googleSignIn';

/**
 * A stand-in for Google's sign-in, for the end-to-end test build only (EXPO_PUBLIC_E2E=true, see authConfig). Google's
 * own sheet cannot be driven by a script, so this one lists three test readers and Cancel. The test server turns each
 * token back into that email; the live server's real check refuses them all.
 */
export const TEST_READERS = [
  { label: 'Test reader: approved', token: 'e2e:tester@example.com' },
  { label: 'Test reader: not approved', token: 'e2e:stranger@example.com' },
  { label: 'Test reader: unverified', token: 'e2e:unverified@example.com' },
] as const;

type Choice = { token: string } | null; // null: the sheet was closed without choosing

// One sheet at a time, shared by the client (which asks) and the sheet component (which shows it).
let pending: ((choice: Choice) => void) | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const isOpen = () => pending !== null;

function ask(): Promise<Choice> {
  pending?.(null); // a second ask cancels the first, so there is never more than one sheet
  return new Promise((resolve) => {
    pending = resolve;
    notify();
  });
}
function answer(choice: Choice) {
  const resolve = pending;
  pending = null;
  notify();
  resolve?.(choice);
}

export function createFakeGoogleClient(): GoogleSignInClient {
  let last: string | null = null; // the reader chosen last, which "silent" sign-in gives back without a sheet
  return {
    async signIn(): Promise<GoogleSignInOutcome> {
      const choice = await ask();
      if (!choice) return { kind: 'cancelled' };
      last = choice.token;
      return { kind: 'ok', idToken: choice.token };
    },
    async signInSilently(): Promise<GoogleSilentOutcome> {
      return last ? { kind: 'ok', idToken: last } : { kind: 'none' };
    },
    async signOut() {
      last = null;
    },
  };
}

/** Mounted once at the root of the test build. Shows nothing until a sign-in asks for it. */
export function FakeGoogleSheet() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen);
  if (!open) return null;
  return (
    <View style={styles.backdrop}>
      <View style={styles.sheet}>
        <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>Choose an account</Text>
        {TEST_READERS.map((reader) => (
          <StateButton key={reader.token} label={reader.label} onPress={() => answer({ token: reader.token })} primary />
        ))}
        <StateButton label="Cancel" onPress={() => answer(null)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, justifyContent: 'center', padding: statePanel.padding },
  sheet: { gap: statePanel.buttonGap, padding: statePanel.padding, borderRadius: statePanel.radius, backgroundColor: colors.statePanel.primaryText, borderWidth: 1, borderColor: colors.statePanel.border },
});
