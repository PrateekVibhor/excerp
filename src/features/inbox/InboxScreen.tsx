import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import type { InboxStore } from '../../data/inboxStore';
import { colors, detail, inbox, typography } from '../../theme';
import { InboxEmptyState, type InboxTab } from './InboxEmptyState';
import { InboxRow } from './InboxRow';
import { inboxKicker } from './inboxText';
import { useInbox } from './useInbox';

const TABS: ReadonlyArray<{ id: InboxTab; label: string }> = [
  { id: 'conversations', label: 'Messages' },
  { id: 'sent', label: 'Sent' },
  { id: 'requests', label: 'Requests' },
];

/**
 * The inbox: requests waiting for an answer, open conversations, and the requests this reader has sent that are still waiting.
 * Newest first, unread ones stronger, and a friendly empty state for each.
 */
export function InboxScreen({ store, now = new Date(), initialTab }: { store?: InboxStore | null; /** The clock used for time labels. */ now?: Date; initialTab?: InboxTab }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const data = useInbox(store);
  const [tab, setTab] = useState<InboxTab>(initialTab ?? 'conversations');
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));
  const list = data[tab];
  const unreadIn = (t: InboxTab) => data[t].reduce((n, c) => n + c.unread, 0);

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton label="Profile" onPress={goBack} />
        </View>

        <View style={[styles.header, { paddingTop: insets.top + detail.backTop + detail.backHeight + inbox.headerTop }]}>
          <Text style={[typography.feedKicker, { color: colors.text.tertiary }]}>
            {data.status === 'ready' ? inboxKicker(data.requests.length + data.conversations.length + data.sent.length, data.unread) : ''}
          </Text>
          <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Inbox</Text>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {TABS.map((t) => {
              const unread = unreadIn(t.id);
              return (
                <Pressable key={t.id} accessibilityRole="tab" accessibilityLabel={unread > 0 ? `${t.label}, ${unread} unread` : t.label} accessibilityState={{ selected: tab === t.id }} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
                  <Text style={[typography.pillButton, { color: colors.text.primary }]}>{unread > 0 ? `${t.label} ${unread}` : t.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {data.status === 'loading' || data.status === 'idle' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text.secondary} />
          </View>
        ) : (
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + inbox.bottomClear }]} showsVerticalScrollIndicator={false}>
            {data.status === 'unavailable' && <Text accessibilityRole="alert" style={[typography.stateBody, { color: colors.statePanel.body }]}>Couldn't load your inbox right now. Pull back in a moment.</Text>}
            {list.length === 0 ? <InboxEmptyState tab={tab} /> : list.map((c) => <InboxRow key={c.id} conversation={c} now={now} onOpen={() => router.push(`/inbox/${c.id}`)} />)}
          </ScrollView>
        )}
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', left: detail.backSide, right: detail.backSide, zIndex: 2, flexDirection: 'row' },
  header: { paddingHorizontal: 24, gap: inbox.headerGap },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 10 },
  tab: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder },
  tabOn: { backgroundColor: colors.detail.backBg },
  scroll: { flex: 1, marginTop: inbox.listTop },
  content: { paddingHorizontal: inbox.sidePadding, gap: inbox.rowGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
