import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomClear } from '../../components/useBottomClear';
import { colors, feed, list, statePanel, typography } from '../../theme';
import { useOpenArticle } from '../article/useOpenArticle';
import { StateButton } from '../feed/FeedStatus';
import { EmptyState } from './EmptyState';
import { useVerifiedSet } from '../quiz/useVerified';
import { ReadingListRow } from './ReadingListRow';
import { useReadingList } from './useReadingList';

export function ReadingListScreen() {
  const insets = useSafeAreaInsets();
  const bottomClear = useBottomClear();
  const { status, entries, count, remove, retry } = useReadingList();
  const { ids: verifiedIds } = useVerifiedSet();
  const openArticle = useOpenArticle('reading-list');

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[typography.feedKicker, { color: colors.text.tertiary }]}>
          {status === 'ready' ? `${count} SAVED` : ''}
        </Text>
        <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Reading List</Text>
      </View>

      {status === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text.secondary} />
        </View>
      )}

      {status === 'error' && (
        <View style={styles.center}>
          <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Couldn't load your reading list</Text>
          <View style={styles.retry}>
            <StateButton label="Retry" onPress={retry} primary />
          </View>
        </View>
      )}

      {status === 'ready' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: bottomClear }]}
          showsVerticalScrollIndicator={false}
        >
          {entries.length === 0 ? (
            <EmptyState />
          ) : (
            entries.map((entry) => (
              <ReadingListRow
                key={entry.item.id}
                entry={entry}
                onOpen={() => openArticle(entry.item.article_id)}
                onRemove={() => remove(entry.item.article_id)}
                verified={verifiedIds.has(entry.item.article_id)}
              />
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingTop: feed.headerPaddingTop,
    paddingHorizontal: feed.sidePadding + 4,
    gap: feed.headerGap,
  },
  scroll: { flex: 1, marginTop: feed.cardAreaTopGap },
  content: { paddingHorizontal: list.sidePadding, gap: list.rowGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap },
  retry: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
