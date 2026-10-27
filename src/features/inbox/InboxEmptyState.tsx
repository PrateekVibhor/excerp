import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { colors, inbox, typography } from '../../theme';

export type InboxTab = 'requests' | 'conversations' | 'sent';

const WORDS: Record<InboxTab, { title: string; body: string }> = {
  requests: { title: 'No requests', body: 'When another reader asks to talk, their request shows up here. You choose whether to accept.' },
  conversations: { title: 'No conversations yet', body: 'Accept a request, or have yours accepted, and the conversation shows up here.' },
  sent: { title: 'Nothing sent', body: 'Requests you send to other readers show up here while you wait for a reply.' },
};

export function InboxEmptyState({ tab = 'conversations' }: { tab?: InboxTab }) {
  return (
    <View style={styles.root}>
      <View style={styles.circle}>
        <Svg width={inbox.emptyIconGlyph} height={inbox.emptyIconGlyph} viewBox="0 0 24 24" fill="none" stroke={colors.inbox.emptyIcon} strokeWidth={2} strokeLinejoin="round">
          <Rect x="3" y="5" width="18" height="14" rx="3" />
          <Path d="m4 7 8 6 8-6" />
        </Svg>
      </View>
      <Text style={[typography.emptyTitle, { color: colors.text.primary }]}>{WORDS[tab].title}</Text>
      <Text style={[typography.stateBody, styles.body, { color: colors.list.emptyBody }]}>{WORDS[tab].body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: inbox.emptyTop, alignItems: 'center', gap: inbox.emptyGap, paddingHorizontal: 24 },
  circle: { width: inbox.emptyIcon, height: inbox.emptyIcon, borderRadius: inbox.emptyIcon / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.statePanel.circleBg, borderWidth: 1, borderColor: colors.statePanel.circleBorder, marginBottom: 8 },
  body: { textAlign: 'center' },
});
