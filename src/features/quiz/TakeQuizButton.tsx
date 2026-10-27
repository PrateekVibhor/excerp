import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { blur, colors, detail, radius, typography } from '../../theme';

/** "Take quiz" under the summary, in the teal of the Save button so it reads as an action on this article. */
export function TakeQuizButton({ questions, onPress }: { questions: number; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Take quiz" accessibilityHint={`${questions} multiple-choice questions`} onPress={onPress} style={styles.button}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <Text style={[typography.saveLabel, { color: colors.detail.saveText }]}>Take quiz</Text>
      {/* Kept together, so with large text they drop to a second line instead of breaking words apart. */}
      <View style={styles.more}>
        <Text style={[typography.cardTag, { color: colors.detail.saveText, opacity: 0.75 }]}>{`${questions} QUESTIONS`}</Text>
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
  more: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: detail.openGap, flexShrink: 0 },
});
