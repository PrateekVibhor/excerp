import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { type SharedValue, withTiming } from 'react-native-reanimated';
import type { Article, SwipeDirection } from '../../data';
import { feed, stack } from '../../theme';
import { SwipeCard, type SwipeCardHandle } from './SwipeCard';

const SETTLE_MS = 250;

export function CardStack({
  articles,
  index,
  dragX,
  onSwipe,
  onOpen,
  verifiedIds,
  ref,
}: {
  articles: Article[];
  /** Position of the top card in `articles`. */
  index: number;
  /** Shared with the buttons so they can react to the drag. */
  dragX: SharedValue<number>;
  onSwipe: (direction: SwipeDirection, article: Article) => void;
  /** The top card was tapped. */
  onOpen?: (article: Article) => void;
  /** Articles whose quiz the reader has passed; their cards show the Verified check. */
  verifiedIds?: ReadonlySet<string>;
  /** Flies the top card off, as the Save and Skip buttons do. */
  ref?: Ref<SwipeCardHandle>;
}) {
  const topRef = useRef<SwipeCardHandle>(null);
  useImperativeHandle(ref, () => ({ flyOut: (direction) => topRef.current?.flyOut(direction) }), []);

  // After a card is promoted, glide the stack back to rest instead of snapping.
  useEffect(() => {
    dragX.value = withTiming(0, { duration: SETTLE_MS });
  }, [index, dragX]);

  const visible = articles.slice(index, index + stack.depth + 1);

  return (
    <View style={styles.area}>
      {visible.map((article, depth) => (
        <View
          key={article.id}
          style={[styles.slot, { zIndex: visible.length - depth }]}
          pointerEvents={depth === 0 ? 'auto' : 'none'}
        >
          <SwipeCard
            article={article}
            depth={depth}
            dragX={dragX}
            ref={depth === 0 ? topRef : undefined}
            onSwipe={(direction) => onSwipe(direction, article)}
            onOpen={() => onOpen?.(article)}
            verified={verifiedIds?.has(article.id) ?? false}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  area: { flex: 1 },
  // Leaves room below the top card for the cards behind it to peek out.
  slot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: feed.stackPeek },
});
