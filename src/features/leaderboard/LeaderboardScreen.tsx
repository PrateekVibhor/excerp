import { useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import { colors, detail, feed, list, statePanel, typography } from '../../theme';
import { StateButton } from '../feed/FeedStatus';
import { LeaderboardRow } from './LeaderboardRow';
import { useLeaderboard, type LeaderboardSources } from './useLeaderboard';

/** The verified leaderboard: everyone who has passed at least one quiz, ranked, with the reader's own place pinned below when it is off the list. */
export function LeaderboardScreen({ sources }: { sources?: LeaderboardSources }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, board, retry } = useLeaderboard(sources);
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  const rows = board?.rows ?? [];
  // Own place below the list only when it is not already one of the rows.
  const pinned = board?.you && !rows.some((r) => r.is_you) ? board.you : null;

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton label="Profile" onPress={goBack} />
        </View>

        <View style={[styles.header, { paddingTop: insets.top + detail.contentTop - 8 }]}>
          <Text style={[typography.feedKicker, { color: colors.text.tertiary }]}>
            {status === 'ready' && rows.length > 0 ? 'VERIFIED READERS' : ''}
          </Text>
          <Text style={[typography.feedTitle, { color: colors.text.primary }]} numberOfLines={1} adjustsFontSizeToFit>
            Leaderboard
          </Text>
        </View>

        {status === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text.secondary} />
          </View>
        )}

        {status === 'error' && (
          <View style={styles.center}>
            <Text style={[typography.stateTitle, styles.centered, { color: colors.text.primary }]}>Couldn't load the leaderboard</Text>
            <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>Check your connection and try again. Everything else in the app still works.</Text>
            <View style={styles.retry}>
              <StateButton label="Retry" onPress={retry} primary />
            </View>
          </View>
        )}

        {status === 'ready' && rows.length === 0 && (
          <View style={styles.center}>
            <Text style={[typography.emptyTitle, styles.centered, { color: colors.text.primary }]}>No verified readers yet</Text>
            <Text style={[typography.stateBody, styles.centered, { color: colors.list.emptyBody }]}>Pass an article's quiz to be the first.</Text>
          </View>
        )}

        {status === 'ready' && rows.length > 0 && (
          <>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (pinned ? 140 : 40) }]}
              showsVerticalScrollIndicator={false}
            >
              {rows.map((row) => (
                <LeaderboardRow key={row.rank} row={row} />
              ))}
            </ScrollView>
            {pinned && (
              <View style={[styles.pinned, { paddingBottom: insets.bottom + 12 }]} accessibilityLabel="Your place">
                <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>YOUR PLACE</Text>
                <LeaderboardRow row={pinned} />
              </View>
            )}
          </>
        )}
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', left: detail.backSide, right: detail.backSide, zIndex: 2, flexDirection: 'row' },
  header: { paddingHorizontal: feed.sidePadding + 4, gap: feed.headerGap },
  scroll: { flex: 1, marginTop: feed.cardAreaTopGap },
  content: { paddingHorizontal: list.sidePadding, gap: list.rowGap },
  pinned: { paddingHorizontal: list.sidePadding, paddingTop: 10, gap: 8, backgroundColor: colors.glass.pinned, borderTopWidth: 1, borderTopColor: colors.detail.peopleBorder },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap, padding: statePanel.padding },
  centered: { textAlign: 'center' },
  retry: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
