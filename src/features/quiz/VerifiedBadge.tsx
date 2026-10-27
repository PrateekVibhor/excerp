import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { colors, radius, statePanel, typography } from '../../theme';

const CHECK = 'M20 6 9 17l-5-5';

/**
 * The Verified mark, in three sizes: `mini` is a check in a small circle for the card (on the monogram's corner) and the Reading List row,
 * `small` is a pill with the word for the article screen, and `large` is the round badge on the result screen,
 * which pops in with a ring that spreads out (unless the phone is set to reduce motion).
 */
export function VerifiedBadge({ size = 'small', corner = false }: { size?: 'mini' | 'small' | 'large'; /** mini only: solid, for sitting on the corner of a publisher's monogram */ corner?: boolean }) {
  if (size === 'large') return <LargeBadge />;
  if (size === 'mini') {
    return (
      <View accessible accessibilityLabel="Verified" style={[styles.mini, corner && styles.corner]}>
        <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={colors.detail.savedIcon} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <Path d={CHECK} />
        </Svg>
      </View>
    );
  }
  return (
    <View accessible accessibilityLabel="Verified" style={styles.pill}>
      <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.detail.savedIcon} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
        <Path d={CHECK} />
      </Svg>
      <Text style={[typography.cardTag, { color: colors.detail.saveText }]}>Verified</Text>
    </View>
  );
}

function LargeBadge() {
  const scale = useSharedValue(0.4);
  const ring = useSharedValue(0);

  useEffect(() => {
    let live = true;
    const settle = (reduced: boolean) => {
      if (!live) return;
      if (reduced) {
        scale.value = 1;
        return;
      }
      scale.value = withSpring(1, { damping: 8, stiffness: 170 });
      ring.value = withTiming(1, { duration: 750, easing: Easing.out(Easing.cubic) });
    };
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.()).then((reduced) => settle(Boolean(reduced)), () => settle(false));
    return () => {
      live = false;
    };
  }, [scale, ring]);

  const badgeStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: Math.min(1, scale.value * 2) }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - ring.value), transform: [{ scale: 1 + ring.value * 0.9 }] }));

  return (
    <View style={styles.largeWrap}>
      <Animated.View pointerEvents="none" style={[styles.circle, styles.ring, ringStyle]} />
      <Animated.View accessible accessibilityLabel="Verified" style={[styles.circle, badgeStyle]}>
        <Svg width={statePanel.icon + 8} height={statePanel.icon + 8} viewBox="0 0 24 24" fill="none" stroke={colors.statePanel.check} strokeWidth={statePanel.iconStroke} strokeLinecap="round" strokeLinejoin="round">
          <Path d={CHECK} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const LARGE = statePanel.circle + 16;
const styles = StyleSheet.create({
  largeWrap: { width: LARGE, height: LARGE, alignItems: 'center', justifyContent: 'center' },
  circle: {
    width: LARGE,
    height: LARGE,
    borderRadius: LARGE / 2,
    backgroundColor: colors.detail.saveBg,
    borderWidth: 1.5,
    borderColor: colors.detail.saveBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { position: 'absolute', backgroundColor: 'transparent' },
  mini: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.detail.saveBg,
    borderWidth: 1,
    borderColor: colors.detail.saveBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: { backgroundColor: colors.badge.ring, borderWidth: 1.5 },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.detail.saveBg,
    borderWidth: 1,
    borderColor: colors.detail.saveBorder,
  },
});
