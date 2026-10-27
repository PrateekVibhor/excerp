import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, sheet, typography } from '../theme';

/** A pill that drops in from the top of the screen. Renders nothing when `message` is null. */
export function Toast({ message }: { message: string | null }) {
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(message === null ? 0 : 1, { duration: 250 });
  }, [message, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -16 }],
  }));
  if (message === null) return null;

  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + sheet.toastTop }]}>
      <Animated.View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.pill, style]}>
        <View style={styles.dot} />
        <Text style={[typography.toast, { color: colors.text.primary }]}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 60 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sheet.toastGap,
    paddingVertical: sheet.toastPaddingV,
    paddingHorizontal: sheet.toastPaddingH,
    borderRadius: 999,
    backgroundColor: colors.sheet.toastBg,
    borderWidth: 1,
    borderColor: colors.sheet.toastBorder,
  },
  dot: { width: sheet.toastDot, height: sheet.toastDot, borderRadius: sheet.toastDot / 2, backgroundColor: colors.sheet.toastDot },
});
