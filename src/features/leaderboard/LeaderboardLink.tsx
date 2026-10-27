import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { blur, colors, detail, list, typography } from '../../theme';

/** The way into the leaderboard, from the Profile screen. It also says, once, that the reader's name is shown there. */
export function LeaderboardLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Leaderboard" accessibilityHint="Opens the ranking of readers by verified articles" onPress={onPress} style={styles.row}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.text}>
        <Text style={[typography.peopleName, { color: colors.text.primary }]}>Leaderboard</Text>
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>Who has verified the most articles. Your name is shown there.</Text>
      </View>
      <Svg width={list.chevronWidth} height={list.chevronHeight} viewBox="0 0 8 14" fill="none">
        <Path d="M1 1l6 6-6 6" stroke={colors.list.chevron} strokeWidth={list.chevronStroke} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.peopleGap,
    minHeight: 64,
    paddingVertical: detail.peopleRowPaddingV + 2,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
    overflow: 'hidden',
  },
  text: { flex: 1, gap: detail.peopleTextGap },
});
