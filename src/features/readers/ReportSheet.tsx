import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardSafeScroll, KeyboardSafeView } from '../../components/KeyboardSafe';
import { REPORT_REASONS, type ReportReason } from '../../data/socialApi';
import { colors, typography } from '../../theme';

export interface ReportDraft {
  reason: ReportReason;
  note: string;
  alsoBlock: boolean;
}
export const NOTE_MAX = 500;

/**
 * Report a reader or a message: pick a reason, add a note if you like, and choose whether to block them as well. The report is kept
 * for review with a copy of what was reported. `onSubmit` gives back an error to show, or nothing when it went through.
 */
export function ReportSheet({
  visible,
  title,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  title: string;
  onSubmit: (draft: ReportDraft) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!visible) return;
    setReason(null);
    setNote('');
    setAlsoBlock(true);
    setBusy(false);
    setError(undefined);
  }, [visible]);

  const send = async () => {
    if (reason === null || busy) return;
    setBusy(true);
    setError(undefined);
    const problem = await onSubmit({ reason, note: note.trim(), alsoBlock });
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardSafeView style={styles.dim}>
        <View accessibilityViewIsModal style={styles.sheet}>
          <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>{title}</Text>
          <Text style={[typography.peopleIndustry, { color: colors.text.secondary }]}>Why are you reporting this? We keep a copy of what you report so we can review it. They are not told.</Text>
          <KeyboardSafeScroll lift={false} scrollStyle={styles.scroll} contentContainerStyle={styles.reasons}>
            {REPORT_REASONS.map((r) => (
              <Pressable key={r.id} accessibilityRole="radio" accessibilityLabel={r.label} accessibilityState={{ selected: reason === r.id }} onPress={() => setReason(r.id)} style={[styles.reason, reason === r.id && styles.chosen]}>
                <View style={[styles.dot, reason === r.id && styles.dotOn]} />
                <Text style={[typography.peopleIndustry, { color: colors.text.primary, flex: 1 }]}>{r.label}</Text>
              </Pressable>
            ))}
            <TextInput
              accessibilityLabel="Add a note (optional)"
              value={note}
              onChangeText={(t) => setNote(Array.from(t).slice(0, NOTE_MAX).join(''))}
              placeholder="Add a note (optional)"
              placeholderTextColor={colors.form.placeholder}
              multiline
              style={[styles.note, typography.sheetInput, { color: colors.text.primary }]}
            />
            <View style={styles.switchRow}>
              <Text style={[typography.peopleIndustry, { color: colors.text.primary, flex: 1 }]}>Also block them</Text>
              <Switch accessibilityLabel="Also block them" value={alsoBlock} onValueChange={setAlsoBlock} trackColor={{ true: colors.accent.default }} />
            </View>
          </KeyboardSafeScroll>
          {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send report" accessibilityState={{ disabled: reason === null || busy }} disabled={reason === null || busy} onPress={() => void send()} style={[styles.button, (reason === null || busy) && styles.off]}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Send report</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={onClose} style={styles.button}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.sheet.dim },
  sheet: { gap: 12, padding: 22, maxHeight: '90%', borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  scroll: { flexGrow: 0, flexShrink: 1 },
  reasons: { gap: 8 },
  reason: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.detail.backBorder },
  chosen: { backgroundColor: colors.detail.backBg },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.detail.backBorder },
  dotOn: { borderColor: colors.accent.default, backgroundColor: colors.accent.default },
  note: { minHeight: 72, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.form.inputBorder, backgroundColor: colors.form.inputBg, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  off: { opacity: 0.5 },
});
