import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { PRIVACY_POLICY_URL } from '../profile/PrivacyLink';
import { TERMS_URL } from './links';

/**
 * Asked the first time a reader turns on being seen or taking messages. It says what other readers will see, and the reader
 * confirms they are 18 or older and accept the Terms of Use: pressing the main button is that confirmation.
 */
export function ConfirmVisibilitySheet({
  visible,
  messages,
  busy,
  error,
  onConfirm,
  onCancel,
  browser,
}: {
  visible: boolean;
  /** True when the reader is turning on messages as well as being seen. */
  messages: boolean;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  browser?: Parameters<typeof openOriginal>[1];
}) {
  const link = (label: string, url: string) => (
    <Pressable accessibilityRole="link" accessibilityLabel={label} hitSlop={10} onPress={() => void openOriginal(url, browser)}>
      <Text style={[typography.formHint, styles.link, { color: colors.text.secondary }]}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.dim}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>Before you turn this on</Text>
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>
            Other readers who have this on will see your name, industry and interests, and that you saved or verified the same article. They will not see your email or anything else about you.
          </Text>
          {messages && (
            <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>
              Readers can send you one text message to ask to talk. You choose whether to accept, and you can block or report anyone.
            </Text>
          )}
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>You must be 18 or older to use this. You can turn it off at any time.</Text>
          {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="I'm 18 or older and accept the Terms" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onConfirm} style={[styles.button, busy && styles.busy]}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>I'm 18 or older and accept the Terms</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={onCancel} style={styles.button}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Cancel</Text>
          </Pressable>
          <View style={styles.links}>
            {link('Terms of Use', TERMS_URL)}
            {link('Privacy Policy', PRIVACY_POLICY_URL)}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.sheet.dim },
  card: { gap: 12, padding: 22, borderRadius: 24, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  body: { lineHeight: 20 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  busy: { opacity: 0.6 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 24 },
  link: { textDecorationLine: 'underline', minHeight: 32, textAlignVertical: 'center' },
});
