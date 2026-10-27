import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { type Ref, useImperativeHandle, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import type { Article, SwipeDirection } from '../../data';
import { blur, card, colors, radius, swipe, typography } from '../../theme';
import { Sheen } from '../../components/Sheen';
import { VerifiedBadge } from '../quiz/VerifiedBadge';
import { brandFor, formatPublishedDate, tagFor, monogramFor, readersLabel, sourceDomain } from './cardFormat';
import {
  dampedY,
  decideSwipe,
  dragProgress,
  labelScale,
  rotationDeg,
  saveProgress,
  skipProgress,
  stackOpacity,
  stackQ,
  stackScale,
  stackTranslateY,
} from './swipeMath';

function Avatar({ id, from, to, first }: { id: string; from: string; to: string; first: boolean }) {
  const r = card.avatar / 2;
  return (
    <Svg
      width={card.avatar}
      height={card.avatar}
      style={first ? undefined : { marginLeft: -card.avatarOverlap }}
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Circle
        cx={r}
        cy={r}
        r={r - card.avatarBorder / 2}
        fill={`url(#${id})`}
        stroke={colors.card.avatarBorder}
        strokeWidth={card.avatarBorder}
      />
    </Svg>
  );
}

/**
 * Inset glow plus a thin ring around the card edge. React Native has no inset
 * shadow, so the glow is four gradients fading inward from each edge; where two
 * edges overlap at a corner it is brighter, as a real inset glow is. The card's
 * own rounded clip shapes the outside of the corners.
 */
function EdgeGlow({
  idPrefix,
  width,
  height,
  ring,
  glow,
}: {
  idPrefix: string;
  width: number;
  height: number;
  ring: string;
  glow: string;
}) {
  const depth = swipe.glowDepth;
  // Each edge strip is filled with a gradient running from the edge inward, in pixel coordinates.
  const edges = [
    { id: 'top', x: 0, y: 0, w: width, h: depth, x1: 0, y1: 0, x2: 0, y2: depth },
    { id: 'bottom', x: 0, y: height - depth, w: width, h: depth, x1: 0, y1: height, x2: 0, y2: height - depth },
    { id: 'left', x: 0, y: 0, w: depth, h: height, x1: 0, y1: 0, x2: depth, y2: 0 },
    { id: 'right', x: width - depth, y: 0, w: depth, h: height, x1: width, y1: 0, x2: width - depth, y2: 0 },
  ];
  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      <Defs>
        {edges.map((e) => (
          <LinearGradient
            key={e.id}
            id={`${idPrefix}-${e.id}`}
            gradientUnits="userSpaceOnUse"
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
          >
            {swipe.glowFalloff.map(([offset, strength]) => (
              <Stop
                key={offset}
                offset={offset}
                stopColor={glow}
                stopOpacity={colors.swipe.glowOpacity * strength}
              />
            ))}
          </LinearGradient>
        ))}
      </Defs>
      {edges.map((e) => (
        <Rect key={e.id} x={e.x} y={e.y} width={e.w} height={e.h} fill={`url(#${idPrefix}-${e.id})`} />
      ))}
      <Rect
        x={swipe.ringWidth / 2}
        y={swipe.ringWidth / 2}
        width={width - swipe.ringWidth}
        height={height - swipe.ringWidth}
        rx={card.radius - swipe.ringWidth / 2}
        fill="none"
        stroke={ring}
        strokeWidth={swipe.ringWidth}
      />
    </Svg>
  );
}

export interface SwipeCardHandle {
  /** Fly the card off exactly as a swipe would; the Save and Skip buttons use this. */
  flyOut: (direction: SwipeDirection) => void;
}

export function SwipeCard({
  article,
  depth = 0,
  dragX,
  onSwipe,
  onOpen,
  verified = false,
  ref,
}: {
  article: Article;
  /** 0 is the top card; higher numbers sit further back in the stack. */
  depth?: number;
  /** Shared across the stack: the top card publishes its drag here, cards behind read it. */
  dragX?: SharedValue<number>;
  /** Called once the card has flown off, with the direction it left in. */
  onSwipe?: (direction: SwipeDirection) => void;
  /** Called when the card is tapped (a touch that moves 10 points or less). */
  onOpen?: () => void;
  /** The reader has passed this article's quiz: a small check shows beside the tag. */
  verified?: boolean;
  ref?: Ref<SwipeCardHandle>;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [summaryLines, setSummaryLines] = useState<number | undefined>(undefined);
  const brand = brandFor(article.source_company);
  const tag = tagFor(article.content_type);

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const opacity = useSharedValue(1);
  const flying = useSharedValue(false);
  const ownDragX = useSharedValue(0);
  const stackDragX = dragX ?? ownDragX;

  // Only the top card publishes its drag; the cards behind rise as it grows.
  // The first run is skipped so a card promoted to the top does not reset the stack.
  useAnimatedReaction(
    () => tx.value,
    (current, previous) => {
      if (depth === 0 && previous !== null) stackDragX.value = current;
    },
    [depth],
  );

  const open = () => onOpen?.();

  const commit = (direction: SwipeDirection) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSwipe?.(direction);
  };

  // The one fly-out path, shared by the pan gesture and the buttons.
  const startFlyOut = (direction: SwipeDirection, dropY: number) => {
    'worklet';
    // Input is ignored while the card is flying off.
    if (flying.value) return;
    flying.value = true;
    const sign = direction === 'right' ? 1 : -1;
    const timing = { duration: swipe.flyDuration, easing: Easing.bezier(0.35, 0.6, 0.45, 1) };
    ty.value = withTiming(ty.value + dropY, timing);
    opacity.value = withTiming(0, { duration: swipe.flyDuration, easing: Easing.in(Easing.quad) });
    tx.value = withTiming(sign * swipe.flyDistance, timing, (finished) => {
      if (finished) scheduleOnRN(commit, direction);
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      flyOut: (direction) => {
        if (depth === 0) startFlyOut(direction, swipe.buttonDropY);
      },
    }),
    [depth],
  );

  const pan = Gesture.Pan()
    .withTestId(depth === 0 ? 'swipe-card' : `swipe-card-${depth}`)
    .enabled(depth === 0)
    .minDistance(swipe.tapMaxDistance)
    .onUpdate((e) => {
      if (flying.value) return;
      tx.value = e.translationX;
      ty.value = dampedY(e.translationY);
    })
    .onEnd((e) => {
      if (flying.value) return;
      const direction = decideSwipe(e.translationX);
      if (!direction) {
        const spring = { damping: swipe.springDamping, stiffness: swipe.springStiffness };
        tx.value = withSpring(0, spring);
        ty.value = withSpring(0, spring);
        return;
      }
      startFlyOut(direction, swipe.flyDropY);
    });

  // A tap and a drag cannot both win: the tap fails once the finger has moved more than
  // the tap distance, and the pan only starts after that same distance. Race lets the
  // first one to activate cancel the other.
  const tap = Gesture.Tap()
    .withTestId(depth === 0 ? 'tap-card' : `tap-card-${depth}`)
    .enabled(depth === 0)
    .maxDistance(swipe.tapMaxDistance)
    .onEnd((_event, success) => {
      if (success && !flying.value) scheduleOnRN(open);
    });
  const gesture = Gesture.Race(pan, tap);

  const cardStyle = useAnimatedStyle(() => {
    if (depth === 0) {
      return {
        opacity: opacity.value,
        transform: [
          { translateX: tx.value },
          { translateY: ty.value },
          { rotate: `${rotationDeg(tx.value)}deg` },
        ],
      };
    }
    const q = stackQ(depth, dragProgress(stackDragX.value));
    return {
      opacity: stackOpacity(q),
      transform: [{ translateY: stackTranslateY(q) }, { scale: stackScale(q) }],
    };
  });
  // Content shows on the top card; the card right behind fades it in as the top one leaves.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: depth === 0 ? 1 : depth === 1 ? dragProgress(stackDragX.value) : 0,
  }));
  const saveGlowStyle = useAnimatedStyle(() => ({ opacity: saveProgress(tx.value) }));
  const skipGlowStyle = useAnimatedStyle(() => ({ opacity: skipProgress(tx.value) }));
  const saveLabelStyle = useAnimatedStyle(() => ({
    opacity: saveProgress(tx.value),
    transform: [{ rotate: `${swipe.labelRotation}deg` }, { scale: labelScale(saveProgress(tx.value)) }],
  }));
  const skipLabelStyle = useAnimatedStyle(() => ({
    opacity: skipProgress(tx.value),
    transform: [{ rotate: `${-swipe.labelRotation}deg` }, { scale: labelScale(skipProgress(tx.value)) }],
  }));

  return (
    <GestureDetector gesture={gesture}>
    <Animated.View style={[styles.shadow, cardStyle]}>
      <View
        style={styles.clip}
        onLayout={(e) => setSize(e.nativeEvent.layout)}
      >
        <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.surface]} />
        {size.width > 0 && (
          <Sheen
            id="sheen"
            width={size.width}
            height={size.height}
            angle={card.gradientAngle}
            color={colors.card.sheen.color}
            stops={[
              [0, colors.card.sheen.opacities[0]],
              [0.45, colors.card.sheen.opacities[1]],
              [1, colors.card.sheen.opacities[2]],
            ]}
          />
        )}
        <View style={styles.highlight} />
        {size.width > 0 && depth === 0 && (
          <>
            <Animated.View style={[StyleSheet.absoluteFill, saveGlowStyle]} pointerEvents="none">
              <EdgeGlow idPrefix={`save-${article.id}`} width={size.width} height={size.height} ring={colors.swipe.save.ring} glow={colors.swipe.save.glow} />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, skipGlowStyle]} pointerEvents="none">
              <EdgeGlow idPrefix={`skip-${article.id}`} width={size.width} height={size.height} ring={colors.swipe.skip.ring} glow={colors.swipe.skip.glow} />
            </Animated.View>
          </>
        )}

        <Animated.View style={[styles.content, contentStyle]}>
          <View style={styles.header}>
            <View>
              <View style={[styles.monogram, { backgroundColor: brand.bg }]}>
                <Text style={[typography.cardMonogram, { color: brand.fg }]}>
                  {monogramFor(article.source_company)}
                </Text>
              </View>
              {/* On the monogram's corner, so the publisher name and domain keep all their room. */}
              {verified && (
                <View style={styles.verifiedCorner}>
                  <VerifiedBadge size="mini" corner />
                </View>
              )}
            </View>
            <View style={styles.company}>
              <Text style={[typography.cardCompany, { color: colors.text.primary }]} numberOfLines={1}>
                {article.source_company}
              </Text>
              <Text style={[typography.cardDomain, { color: colors.text.tertiary }]} numberOfLines={1}>
                {sourceDomain(article.source_url)}
              </Text>
            </View>
            <View style={[styles.tag, { backgroundColor: tag.bg }]}>
              <Text style={[typography.cardTag, { color: tag.fg }]}>{article.content_type}</Text>
            </View>
          </View>

          <Text style={[typography.cardTitle, { color: colors.text.primary }]} numberOfLines={card.titleLines}>
            {article.title}
          </Text>
          {/* Takes whatever room is left, and cuts the summary with an ellipsis at the line count
              that fits, so on a small screen the footer is never pushed off the card. */}
          <View
            testID="summary-box"
            style={styles.summaryBox}
            onLayout={(e) =>
              setSummaryLines(Math.max(1, Math.floor(e.nativeEvent.layout.height / typography.cardSummary.lineHeight)))
            }
          >
            <Text style={[typography.cardSummary, { color: colors.card.summary }]} numberOfLines={summaryLines}>
              {article.summary}
            </Text>
          </View>
          <View style={styles.divider} />

          <View style={styles.footer}>
            <View style={styles.avatars}>
              {colors.card.avatars.map(([from, to], i) => (
                <Avatar key={i} id={`avatar-${article.id}-${i}`} from={from} to={to} first={i === 0} />
              ))}
            </View>
            <Text style={[typography.cardReaders, styles.readers, { color: colors.card.readers }]}>
              {readersLabel(article.reader_count)}
            </Text>
            <Text style={[typography.cardDate, { color: colors.text.tertiary }]}>
              {formatPublishedDate(article.published_at)}
            </Text>
          </View>
        </Animated.View>

        <Animated.View
          pointerEvents="none"
          style={[
            styles.label,
            styles.saveLabel,
            { borderColor: colors.swipe.save.labelBorder, backgroundColor: colors.swipe.save.labelBg },
            saveLabelStyle,
          ]}
        >
          <Text style={[typography.swipeLabel, { color: colors.swipe.save.labelText }]}>SAVE</Text>
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.label,
            styles.skipLabel,
            { borderColor: colors.swipe.skip.labelBorder, backgroundColor: colors.swipe.skip.labelBg },
            skipLabelStyle,
          ]}
        >
          <Text style={[typography.swipeLabel, { color: colors.swipe.skip.labelText }]}>SKIP</Text>
        </Animated.View>
      </View>
    </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  shadow: {
    flex: 1,
    transformOrigin: '50% 100%',
    borderRadius: card.radius,
    shadowColor: colors.shadow.tabBar,
    shadowOpacity: 1,
    shadowRadius: card.shadowRadius,
    shadowOffset: { width: 0, height: card.shadowOffsetY },
  },
  clip: {
    flex: 1,
    borderRadius: card.radius,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.glass,
  },
  surface: { backgroundColor: colors.glass.surface },
  highlight: {
    position: 'absolute',
    top: 0,
    left: card.radius / 2,
    right: card.radius / 2,
    height: 1,
    backgroundColor: colors.card.highlight,
  },
  content: { flex: 1, padding: card.padding, gap: card.gap },
  header: { flexDirection: 'row', alignItems: 'center', gap: card.headerGap },
  monogram: {
    width: card.monogram,
    height: card.monogram,
    borderRadius: card.monogramRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  company: { flex: 1, gap: 3, minWidth: 0 },
  verifiedCorner: { position: 'absolute', right: -7, bottom: -7 },
  tag: {
    paddingVertical: card.tagPaddingV,
    paddingHorizontal: card.tagPaddingH,
    borderRadius: radius.pill,
  },
  summaryBox: { flex: 1, minHeight: 0, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: colors.card.divider },
  footer: { flexDirection: 'row', alignItems: 'center', gap: card.footerGap },
  avatars: { flexDirection: 'row' },
  readers: { flex: 1 },
  label: {
    position: 'absolute',
    top: swipe.labelTop,
    paddingVertical: swipe.labelPaddingV,
    paddingHorizontal: swipe.labelPaddingH,
    borderRadius: swipe.labelRadius,
    borderWidth: swipe.labelBorder,
  },
  saveLabel: { right: swipe.labelInset },
  skipLabel: { left: swipe.labelInset },
});
