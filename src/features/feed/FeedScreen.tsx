import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { actions, colors, feed, typography } from '../../theme';
import { ActionButtons } from './ActionButtons';
import { AllCaughtUp } from './AllCaughtUp';
import { useVerifiedSet } from '../quiz/useVerified';
import { CardStack } from './CardStack';
import { useOpenArticle } from '../article/useOpenArticle';
import { ErrorState, LoadingState } from './FeedStatus';
import type { SwipeCardHandle } from './SwipeCard';
import { useFeed } from './useFeed';

export function FeedScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const openArticle = useOpenArticle('feed');
  const { status, articles, index, total, remaining, done, savedThisSession, swipe, retry } = useFeed();
  const { ids: verifiedIds } = useVerifiedSet();
  const dragX = useSharedValue(0);
  const stackRef = useRef<SwipeCardHandle>(null);

  const showCards = status === 'ready' && !done;
  const kicker = status === 'loading' ? 'LOADING' : status === 'error' ? 'UNAVAILABLE' : `${remaining} NEW`;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[typography.feedKicker, { color: colors.text.tertiary }]}>{kicker}</Text>
        <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Discover</Text>
      </View>

      <View style={[styles.cardArea, { marginBottom: insets.bottom + feed.cardAreaBottom }]}>
        {status === 'loading' && <LoadingState />}
        {status === 'error' && <ErrorState onRetry={retry} />}
        {showCards && (
          <CardStack
            ref={stackRef}
            articles={articles}
            index={index}
            dragX={dragX}
            onSwipe={swipe}
            onOpen={(article) => openArticle(article.id)}
            verifiedIds={verifiedIds}
          />
        )}
        {done && (
          <AllCaughtUp
            reviewed={total}
            savedThisSession={savedThisSession}
            onOpenReadingList={() => router.navigate('/reading-list')}
          />
        )}
      </View>

      <View
        style={[styles.actions, { bottom: insets.bottom + actions.bottomAboveSafeArea }]}
        pointerEvents="box-none"
      >
        <ActionButtons
          dragX={dragX}
          progressLabel={showCards ? `${Math.min(index + 1, total)} / ${total}` : ''}
          disabled={!showCards}
          onSkip={() => stackRef.current?.flyOut('left')}
          onSave={() => stackRef.current?.flyOut('right')}
        />
      </View>
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
  cardArea: {
    flex: 1,
    marginTop: feed.cardAreaTopGap,
    marginHorizontal: feed.sidePadding,
    zIndex: 0,
  },
  actions: {
    position: 'absolute',
    zIndex: 1,
    left: actions.sideInset,
    right: actions.sideInset,
  },
});
