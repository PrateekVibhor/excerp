import { useEffect, useRef } from 'react';
import { StyleSheet, Text, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { badge, colors, radius, typography } from '../theme';
import { badgeLabel, shouldPop } from './badge';

/**
 * Count pill, placed over its parent. Hidden at zero; pops when the count rises.
 * Defaults to the tab bar's size and position; `max` caps the number shown ("9+")
 * and `placement` moves or reshapes the pill.
 */
export function TabBadge({
  count,
  max,
  placement,
}: {
  count: number;
  max?: number;
  placement?: ViewStyle;
}) {
  const scale = useSharedValue(1);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (shouldPop(previous.current, count)) {
      scale.value = withSequence(
        withTiming(badge.popScale, { duration: badge.popUpMs }),
        withSpring(1, badge.popSpring),
      );
    }
    previous.current = count;
  }, [count, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const label = badgeLabel(count, max);
  if (label === null) return null;

  return (
    <Animated.View style={[styles.pill, placement ?? styles.onTab, style]} pointerEvents="none">
      <Text style={[typography.badge, { color: colors.badge.text }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    minWidth: badge.minWidth,
    height: badge.height,
    paddingHorizontal: badge.paddingH,
    borderRadius: radius.pill,
    backgroundColor: colors.badge.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onTab: { top: badge.top, left: badge.left },
});
