import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { accountSync as defaultSync } from '../../data';
import type { AccountSync } from '../../data/accountSync';
import { colors, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { PRIVACY_POLICY_URL } from '../profile/PrivacyLink';
import { useAuth } from './useAuth';

/**
 * The one-time message shown when a reader's data starts being saved to their account: after they first complete their
 * profile or verify an article, or once for a reader who was already using the app. It says what is kept and where to delete
 * it all, and is not shown again once dismissed. Nothing at all with no sign-in (mock data).
 */
export function SyncNotice({ sync = defaultSync, browser }: { sync?: AccountSync; browser?: Parameters<typeof openOriginal>[1] }) {
  const auth = useAuth();
  const [pending, setPending] = useState(() => sync.noticePending());
  useEffect(() => {
    setPending(sync.noticePending());
    return sync.subscribeNotice(() => setPending(sync.noticePending()));
  }, [sync]);

  if (!auth || auth.state.kind !== 'approved' || !pending) return null;
  const dismiss = () => {
    setPending(false);
    void sync.acknowledgeNotice();
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismiss}>
      <View style={styles.dim}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>
            Your data is now saved to your account
          </Text>
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>
            Your profile, saved articles and verified articles are now kept on our server, tied to your Google account, so you don't lose them if you change phones.
          </Text>
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>
            We also count which articles you skip, tied to your account. Other readers see only your leaderboard name and your number of verified articles.
          </Text>
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>
            You can delete all of it at any time from Profile, under Delete account.
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="OK" onPress={dismiss} style={styles.ok}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>OK</Text>
          </Pressable>
          <Pressable accessibilityRole="link" accessibilityLabel="Read the privacy policy" hitSlop={12} onPress={() => void openOriginal(PRIVACY_POLICY_URL, browser)} style={styles.link}>
            <Text style={[typography.formHint, styles.linkText, { color: colors.text.tertiary }]}>Read the privacy policy</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.sheet.dim },
  card: { gap: 12, padding: 22, borderRadius: 24, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  body: { lineHeight: 20 },
  ok: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4, borderRadius: 999, backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { textDecorationLine: 'underline', fontSize: 12 },
});
