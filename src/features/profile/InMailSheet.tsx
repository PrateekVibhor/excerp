import { BlurView } from 'expo-blur';
import { useEffect, useState } from 'react';
import { Keyboard, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../../components/Avatar';
import { KeyboardSafeView, useKeyboardVisible } from '../../components/KeyboardSafe';
import { looksLikeLink, validateDraft } from '../../data/messageDraft';
import { blur, colors, sheet, typography } from '../../theme';

/** What the sheet says under the message, so nobody is surprised. */
export const NEW_NOTE = 'This is a request. They can accept or decline, and you can send just this one message until they reply. Text only: no links.';
export const REPLY_NOTE = 'Text only: no links.';

export interface Recipient {
  /** The reader's public id. */
  readerId: string;
  name: string;
  initials: string;
  tone: 0 | 1 | 2;
}

export type SendOutcome = { ok: true } | { ok: false; message: string };

/**
 * The message sheet, shared by a first message request to a reader (titled "Message request") and a reply (titled "Reply").
 * `onSend` does the sending and says how it went; on success `onSent` runs, and on failure the reason is shown here.
 */
export function InMailSheet({
  visible,
  mode,
  to,
  initialSubject,
  onSend,
  onClose,
  onSent,
}: {
  visible: boolean;
  mode: 'new' | 'reply';
  to: Recipient;
  initialSubject: string;
  onSend: (draft: { subject: string; body: string }) => Promise<SendOutcome>;
  onClose: () => void;
  onSent: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();

  // Every time the sheet opens it starts fresh: the prefilled subject and an empty message.
  useEffect(() => {
    if (!visible) return;
    setSubject(initialSubject);
    setBody('');
    setSending(false);
    setFailed(undefined);
  }, [visible, initialSubject]);

  const errors = validateDraft({ subject, body });
  // A blank message just keeps Send off; a message is only shown for text that is too long, or that has a link in it.
  const linkError = looksLikeLink(subject) || looksLikeLink(body) ? "Links and email addresses aren't allowed." : undefined;
  const bodyError = body.trim() !== '' ? (errors.body ?? linkError) : undefined;
  const canSend = !errors.subject && !errors.body && !linkError && !sending;

  const close = () => {
    Keyboard.dismiss();
    onClose();
  };
  const send = async () => {
    if (!canSend) return;
    Keyboard.dismiss();
    setSending(true);
    setFailed(undefined);
    try {
      const outcome = await onSend({ subject: subject.trim(), body: body.trim() });
      if (outcome.ok) onSent();
      else {
        setFailed(outcome.message);
        setSending(false);
      }
    } catch {
      setFailed("Couldn't send your message. Try again.");
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      {/* With the keyboard up the sheet shrinks to fit; the top padding keeps its header below the status bar. */}
      <KeyboardSafeView style={[styles.root, { paddingTop: insets.top + sheet.topGap }]}>
        {/* With the keyboard up, a tap outside the sheet only puts the keyboard away; with it down, it closes the sheet. */}
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={keyboard ? Keyboard.dismiss : close} style={styles.dim} />
        {/* A tap on empty space closes the keyboard; the fields and buttons handle their own taps first. */}
        <Pressable accessible={false} onPress={Keyboard.dismiss} style={[styles.sheet, keyboard && styles.sheetKeyboard]}>
          <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={close} hitSlop={10} style={[styles.headerButton, { alignItems: 'flex-start' }]}>
              <Text style={[typography.sheetAction, { color: colors.sheet.cancel }]}>Cancel</Text>
            </Pressable>
            <Text accessibilityRole="header" style={[typography.sheetTitle, { color: colors.text.primary }]}>
              {mode === 'reply' ? 'Reply' : 'Message request'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={send}
              hitSlop={10}
              style={[styles.headerButton, { alignItems: 'flex-end', opacity: canSend ? 1 : sheet.sendDisabledOpacity }]}
            >
              <Text style={[typography.sheetSend, { color: colors.sheet.send }]}>Send</Text>
            </Pressable>
          </View>

          <View style={styles.toRow}>
            <Text style={[typography.sheetTo, { color: colors.sheet.toLabel }]}>To</Text>
            <Avatar initials={to.initials} tone={to.tone} size={sheet.toAvatar} id={`sheet-to-${to.readerId}`} textStyle={typography.peopleInitials} />
            <Text style={[typography.sheetName, { color: colors.text.primary }]}>{to.name}</Text>
          </View>

          <View style={styles.field}>
            <TextInput
              accessibilityLabel="Subject"
              value={subject}
              onChangeText={setSubject}
              placeholder="Subject"
              placeholderTextColor={colors.form.placeholder}
              selectionColor={colors.accent.default}
              style={[styles.input, styles.subject, typography.sheetInput, { color: colors.text.primary }, errors.subject !== undefined && styles.inputError]}
            />
            {errors.subject !== undefined && (
              <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{errors.subject}</Text>
            )}
          </View>

          <View style={[styles.field, styles.bodyField]}>
            <TextInput
              accessibilityLabel="Message"
              value={body}
              onChangeText={setBody}
              placeholder={'Write a message…'}
              placeholderTextColor={colors.form.placeholder}
              selectionColor={colors.accent.default}
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.body, typography.sheetInput, { color: colors.text.primary }, bodyError !== undefined && styles.inputError]}
            />
            {bodyError !== undefined && (
              <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{bodyError}</Text>
            )}
          </View>

          {failed !== undefined && (
            <Text accessibilityRole="alert" style={[typography.formHint, styles.failed, { color: colors.form.error }]}>
              {failed}
            </Text>
          )}
          <Text style={[typography.sheetLabel, { color: colors.sheet.label }]}>{mode === 'new' ? NEW_NOTE : REPLY_NOTE}</Text>
        </Pressable>
      </KeyboardSafeView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.sheet.dim },
  sheet: {
    height: sheet.height,
    // It is at most sheet.height but gives way to the room there is between the status bar and the keyboard (the root's top padding and the keyboard's padding), so
    // its header can never be pushed up under the status bar. (A percentage maximum did not count that padding.) The message area, flex 1, gives first.
    flexShrink: 1,
    borderTopLeftRadius: sheet.radius,
    borderTopRightRadius: sheet.radius,
    backgroundColor: colors.sheet.bg,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.sheet.border,
    paddingTop: sheet.paddingTop,
    paddingHorizontal: sheet.padding,
    paddingBottom: sheet.paddingBottom,
    gap: sheet.gap,
    overflow: 'hidden',
  },
  sheetKeyboard: { paddingBottom: sheet.paddingBottomKeyboard },
  headerButton: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  grabber: { alignSelf: 'center', width: sheet.grabberWidth, height: sheet.grabberHeight, borderRadius: sheet.grabberHeight, backgroundColor: colors.sheet.grabber },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sheet.toRowGap,
    height: sheet.toRowHeight,
    paddingHorizontal: sheet.toRowPaddingH,
    borderRadius: sheet.toRowRadius,
    backgroundColor: colors.sheet.toRowBg,
    borderWidth: 1,
    borderColor: colors.sheet.toRowBorder,
  },
  field: { gap: 6 },
  bodyField: { flex: 1, minHeight: 0 },
  input: {
    borderRadius: sheet.inputRadius,
    backgroundColor: colors.form.inputBg,
    borderWidth: 1,
    borderColor: colors.form.inputBorder,
  },
  subject: { height: sheet.subjectHeight, paddingHorizontal: sheet.inputPaddingH },
  body: { flex: 1, padding: sheet.bodyPadding },
  inputError: { borderColor: colors.form.error },
  failed: { textAlign: 'center' },
});
