import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Avatar } from '../../components/Avatar';
import { colors, list, message, typography } from '../../theme';
import type { Sender } from './inboxText';

/**
 * Who the conversation is with. With `onOpen` and a profile to open, the whole card opens that reader's profile; for a deleted
 * account it is only a label.
 */
export function SenderCard({ sender, avatarId, onOpen }: { sender: Sender; avatarId: string; onOpen?: () => void }) {
  const body = (
    <>
      <Avatar initials={sender.initials} tone={sender.tone} size={message.senderAvatar} id={avatarId} textStyle={typography.peopleName} />
      <View style={styles.text}>
        <Text style={[typography.detailCompany, { color: colors.text.primary }]}>{sender.name}</Text>
        {sender.industry !== null && <Text style={[typography.detailDomain, { color: colors.text.tertiary }]}>{sender.industry}</Text>}
      </View>
    </>
  );

  if (!onOpen || sender.publicId === null) {
    return (
      <View accessibilityLabel={`With ${sender.name}`} style={styles.card}>
        {body}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${sender.name}'s profile`} onPress={onOpen} style={styles.card}>
      {body}
      <Svg width={message.chevronWidth} height={message.chevronHeight} viewBox="0 0 8 14">
        <Path d="M1 1l6 6-6 6" stroke={colors.list.chevron} strokeWidth={list.chevronStroke} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: message.senderGap, paddingVertical: message.senderPaddingV, paddingLeft: message.senderPaddingLeft, paddingRight: message.senderPaddingRight, borderRadius: 22, backgroundColor: colors.detail.peopleBg, borderWidth: 1, borderColor: colors.detail.peopleBorder },
  text: { flex: 1, minWidth: 0, gap: message.senderTextGap },
});
