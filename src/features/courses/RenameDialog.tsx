import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardSafeView } from '../../components/KeyboardSafe';
import { colors, font, typography } from '../../theme';

export const TITLE_MAX = 80;

/** Naming a list: one line, up to 80 characters. Leaving it empty goes back to the default name. Saving gives the trimmed name ('' to clear it). */
export function RenameDialog({ visible, initial, busy = false, error, onSave, onCancel }: {
  visible: boolean;
  initial: string;
  busy?: boolean;
  /** Why the last try did not work. */
  error?: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);
  const save = () => onSave(value.trim());

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardSafeView style={styles.dim}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>Rename list</Text>
          <TextInput
            accessibilityLabel="List name"
            autoFocus
            value={value}
            onChangeText={(t) => setValue(t.replace(/[\r\n]+/g, ' '))}
            maxLength={TITLE_MAX}
            returnKeyType="done"
            onSubmitEditing={save}
            placeholderTextColor={colors.form.placeholder}
            style={styles.input}
          />
          <View style={styles.meta}>
            <Text style={styles.hint}>Leave it empty to use the default name.</Text>
            <Text style={styles.hint}>{`${value.length}/${TITLE_MAX}`}</Text>
          </View>
          {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" accessibilityLabel="Save" accessibilityState={{ disabled: busy }} disabled={busy} onPress={save} style={[styles.button, styles.primary, busy && { opacity: 0.6 }]}>
              <Text style={[typography.pillButton, { color: '#ffffff' }]}>Save</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={onCancel} style={styles.button}>
              <Text style={[typography.pillButton, { color: colors.text.primary }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.sheet.dim },
  card: { gap: 12, padding: 22, borderRadius: 24, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  input: { height: 50, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.form.inputBg, borderWidth: 1, borderColor: colors.form.inputBorder, fontFamily: font.sans.regular, fontSize: 16, color: colors.text.primary },
  meta: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  hint: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted, flexShrink: 1 },
  buttons: { gap: 8, marginTop: 4 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  primary: { backgroundColor: colors.course.strong.bg, borderColor: colors.course.strong.bg },
});
