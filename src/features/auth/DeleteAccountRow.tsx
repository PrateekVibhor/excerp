import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, detail, typography } from '../../theme';
import { useAuth } from './useAuth';

/**
 * Delete account, under the account reference. Pressing it asks first: it says what leaves the server (the list in the privacy
 * policy's "Delete your Excerp account" section), and asks whether the account's data should also be removed from this phone.
 * Keeping it is the default, and removing it is never done without the reader choosing it. Nothing at all with no sign-in.
 */
export function DeleteAccountRow() {
  const auth = useAuth();
  const [asking, setAsking] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!auth || auth.state.kind !== 'approved') return null;

  const close = () => {
    setAsking(false);
    setWipe(false);
    setFailed(false);
  };
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const done = await auth.deleteAccount({ wipe });
    setBusy(false);
    if (!done) setFailed(true); // when it is done the reader is signed out and this screen goes away
  };

  if (!asking) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Delete account" onPress={() => setAsking(true)} style={styles.row}>
        <View style={styles.text}>
          <Text style={[typography.peopleName, { color: colors.text.primary }]}>Delete account</Text>
          <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>Removes your data from our server.</Text>
        </View>
      </Pressable>
    );
  }

  const choice = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected, disabled: busy }} disabled={busy} onPress={onPress} style={[styles.choice, selected && styles.chosen]}>
      <View style={[styles.dot, selected && styles.dotOn]} />
      <Text style={[typography.peopleIndustry, styles.choiceText, { color: colors.text.primary }]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={[typography.peopleName, { color: colors.text.primary }]}>Delete your account?</Text>
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>
          This deletes your email address, your profile, your saved articles and verified articles, your skip counts, your leaderboard entries,
          your place on the approved or waiting list and your sign-in sessions from our server. It can't be undone.
        </Text>
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>
          Messages you sent stay with the readers you sent them to, without your name, until they expire.
        </Text>
        {auth.provider === 'apple' && (
          <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>
            You'll be asked to sign in with Apple again, so Apple can be told this account is gone.
          </Text>
        )}
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>
          {wipe
            ? 'Your saved articles, verified badges and profile will be removed from this phone too.'
            : 'Your saved articles, verified badges and profile stay on this phone unless you choose to remove them too.'}
        </Text>
      </View>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {choice('Keep my data on this phone', !wipe, () => setWipe(false))}
        {choice('Also remove my data from this phone', wipe, () => setWipe(true))}
      </View>
      {failed && (
        <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>
          {auth.provider === 'apple' ? "Couldn't delete your account. Check your connection and sign in with Apple when asked, then try again." : "Couldn't delete your account. Check your connection and try again."}
        </Text>
      )}
      <View style={styles.buttons}>
        <Pressable accessibilityRole="button" accessibilityLabel="Yes, delete my account" disabled={busy} onPress={() => void confirm()} style={[styles.button, styles.danger]}>
          <Text style={[typography.pillButton, { color: colors.form.error }]}>Yes, delete my account</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={close} style={styles.button}>
          <Text style={[typography.pillButton, { color: colors.text.primary }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    justifyContent: 'center',
    gap: 12,
    paddingVertical: detail.peopleRowPaddingV + 2,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
  },
  text: { gap: detail.peopleTextGap },
  choices: { gap: 8 },
  choice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.detail.backBorder },
  chosen: { backgroundColor: colors.detail.backBg },
  choiceText: { flex: 1 },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.detail.backBorder },
  dotOn: { borderColor: colors.form.error, backgroundColor: colors.form.error },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  danger: { borderColor: colors.form.error },
});
