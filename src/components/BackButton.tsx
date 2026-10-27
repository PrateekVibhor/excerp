import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { blur, colors, detail, radius, typography } from '../theme';

/** The glass "‹ Back" pill used at the top left of screens above the tabs. */
export function BackButton({ label = 'Back', onPress }: { label?: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onPress} style={styles.back}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <Svg width={detail.chevronWidth} height={detail.chevronHeight} viewBox="0 0 12 20" fill="none">
        <Path
          d="M10 2L2 10l8 8"
          stroke={colors.text.primary}
          strokeWidth={detail.chevronStroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      <Text style={[typography.backLabel, { color: colors.text.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: {
    height: detail.backHeight,
    paddingLeft: detail.backPaddingLeft,
    paddingRight: detail.backPaddingRight,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.backGap,
    backgroundColor: colors.detail.backBg,
    borderWidth: 1,
    borderColor: colors.detail.backBorder,
    overflow: 'hidden',
  },
});
