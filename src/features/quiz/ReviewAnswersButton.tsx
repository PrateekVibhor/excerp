import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { blur, colors, detail, radius, typography } from '../../theme';

/** On a verified article: the Verified mark, and a way to open the quiz again as a read-only review. */
export function ReviewAnswersButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Verified, review answers" onPress={onPress} style={styles.button}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.left}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.detail.savedIcon} strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M20 6 9 17l-5-5" />
        </Svg>
        <Text style={[typography.saveLabel, { color: colors.detail.saveText }]}>Verified</Text>
      </View>
      <View style={styles.more}>
        <Text style={[typography.cardTag, { color: colors.detail.saveText, opacity: 0.75 }]}>REVIEW ANSWERS</Text>
        <Svg width={detail.openIcon} height={detail.openIcon} viewBox="0 0 24 24" fill="none" stroke={colors.detail.saveText} strokeWidth={detail.openIconStroke} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M5 12h14M13 6l6 6-6 6" />
        </Svg>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: detail.openHeight,
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    rowGap: 4,
    columnGap: detail.openGap,
    backgroundColor: colors.detail.saveBg,
    borderWidth: 1,
    borderColor: colors.detail.saveBorder,
    overflow: 'hidden',
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  more: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: detail.openGap, flexShrink: 0 },
});
