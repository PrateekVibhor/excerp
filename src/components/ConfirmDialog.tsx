import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../theme';

/** A small centered question with a confirm button and a cancel button. */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** The label of the button that does nothing. */
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /** Why the last try did not work, shown under the question. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.dim}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>{title}</Text>
          <Text style={[typography.peopleIndustry, styles.body, { color: colors.text.secondary }]}>{body}</Text>
          {error ? (
            <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text>
          ) : null}
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" accessibilityLabel={confirmLabel} accessibilityState={{ disabled: busy }} disabled={busy} onPress={onConfirm} style={[styles.button, destructive && styles.danger, busy && styles.busy]}>
              <Text style={[typography.pillButton, { color: destructive ? colors.form.error : colors.text.primary }]}>{confirmLabel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={cancelLabel} disabled={busy} onPress={onCancel} style={styles.button}>
              <Text style={[typography.pillButton, { color: colors.text.primary }]}>{cancelLabel}</Text>
            </Pressable>
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
  buttons: { gap: 8, marginTop: 4 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  danger: { borderColor: colors.form.error },
  busy: { opacity: 0.6 },
});
