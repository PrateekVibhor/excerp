import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '../../components/Avatar';
import type { ConversationView } from '../../data/socialApi';
import { blur, colors, inbox, typography } from '../../theme';
import { firstParagraph, NO_TEXT, otherOf, stateNote, subjectOf } from './inboxText';
import { rowTimeLabel } from './timeLabel';

/** One conversation in the inbox. Unread ones are stronger: brighter fill, cyan border, heavier type, a dot. */
export function InboxRow({ conversation, now, onOpen }: { conversation: ConversationView; now: Date; onOpen: () => void }) {
  const other = otherOf(conversation);
  const last = conversation.last_message;
  const unread = conversation.unread > 0;
  const preview = last ? firstParagraph(last.body) : null;
  const subject = last ? subjectOf(last.subject) : '';
  const note = stateNote(conversation);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${subject} with ${other.name}`}
      accessibilityValue={{ text: unread ? 'unread' : 'read' }}
      onPress={onOpen}
      style={[styles.row, { backgroundColor: unread ? colors.inbox.unreadBg : colors.inbox.readBg }, { borderColor: unread ? colors.inbox.unreadBorder : colors.inbox.readBorder }]}
    >
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <Avatar initials={other.initials} tone={other.tone} size={inbox.avatar} id={`inbox-avatar-${conversation.id}`} textStyle={typography.cardMonogram} />
      <View style={styles.text}>
        <View style={styles.topLine}>
          <Text numberOfLines={1} style={[unread ? typography.inboxNameUnread : typography.inboxNameRead, styles.name, { color: colors.text.primary }]}>{other.name}</Text>
          <Text style={[typography.rowMeta, { color: unread ? colors.inbox.unreadTime : colors.inbox.readTime }]}>{rowTimeLabel(conversation.last_message_at, now)}</Text>
          {unread && <View style={styles.dot} />}
        </View>
        {other.industry !== null && <Text style={[typography.rowMeta, { color: colors.inbox.industry }]}>{other.industry}</Text>}
        <Text numberOfLines={1} style={[unread ? typography.inboxSubjectUnread : typography.inboxSubjectRead, styles.subject, { color: unread ? colors.text.primary : colors.inbox.subjectRead }]}>{subject}</Text>
        <Text numberOfLines={1} style={[typography.inboxPreview, { color: preview === null ? colors.inbox.previewEmpty : colors.inbox.preview }]}>
          {last?.from === 'me' ? 'You: ' : ''}
          {preview ?? NO_TEXT}
        </Text>
        {note !== null && <Text style={[typography.rowMeta, { color: colors.inbox.industry }]}>{note}</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: inbox.innerGap, padding: inbox.rowPadding, borderRadius: inbox.rowRadius, borderWidth: 1, overflow: 'hidden' },
  text: { flex: 1, minWidth: 0, gap: inbox.textGap },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: inbox.topLineGap },
  name: { flex: 1, minWidth: 0 },
  dot: { width: inbox.dot, height: inbox.dot, borderRadius: inbox.dot / 2, backgroundColor: colors.inbox.unreadDot },
  subject: { marginTop: inbox.subjectTop },
});
