import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, profile as layout, typography } from '../../theme';
import { AppleButton } from './AppleButton';
import { GateScreen } from './GateScreen';
import { GoogleG } from './GoogleG';
import { SignInNotice } from './SignInNotice';
import { useAuth } from './useAuth';

/** The first screen for a reader who is not signed in. */
export function SignInScreen() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  if (!auth) return null;

  const attempt = async (signIn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await signIn();
    } finally {
      setBusy(false);
    }
  };
  const onPress = () => attempt(() => auth.signIn());
  const apple = auth.appleAvailable === true && auth.signInWithApple !== undefined;

  return (
    <GateScreen title="Welcome to Excerp" body="Keep it simple">
      {auth.error && (
        <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>
          {apple ? "Couldn't sign in. Try again." : "Couldn't sign in with Google. Try again."}
        </Text>
      )}
      {apple && <AppleButton disabled={busy} onPress={() => void attempt(() => auth.signInWithApple!())} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Sign in with Google" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onPress} style={[styles.button, busy && styles.busy]}>
        <View style={styles.logo}>
          <GoogleG size={20} />
        </View>
        <Text style={[typography.pillButton, { color: colors.text.primary }]}>Sign in with Google</Text>
      </Pressable>
      <SignInNotice />
    </GateScreen>
  );
}

const styles = StyleSheet.create({
  // The container uses the Profile screen's pill tokens; only the G inside it keeps Google's own colors.
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: layout.pillPaddingH + 8,
    borderRadius: 999,
    backgroundColor: colors.detail.backBg,
    borderWidth: 1,
    borderColor: colors.detail.backBorder,
  },
  busy: { opacity: 0.6 },
  logo: { width: 20, height: 20 },
});
