import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { actions, blur, colors, radius, typography } from '../../theme';
import { buttonScale, saveProgress, skipProgress } from './swipeMath';

export function ActionButtons({
  dragX,
  progressLabel,
  disabled,
  onSkip,
  onSave,
}: {
  dragX: SharedValue<number>;
  progressLabel: string;
  disabled: boolean;
  onSkip: () => void;
  onSave: () => void;
}) {
  const skipScale = useAnimatedStyle(() => ({ transform: [{ scale: buttonScale(skipProgress(dragX.value)) }] }));
  const saveScale = useAnimatedStyle(() => ({ transform: [{ scale: buttonScale(saveProgress(dragX.value)) }] }));

  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <Animated.View style={skipScale}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip"
          disabled={disabled}
          onPress={onSkip}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: pressed ? colors.button.skip.pressedBg : colors.button.skip.bg, borderColor: colors.button.skip.border },
          ]}
        >
          <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
          <Svg width={actions.skipIcon} height={actions.skipIcon} viewBox="0 0 24 24" fill="none" stroke={colors.button.skip.icon} strokeWidth={actions.skipIconStroke} strokeLinecap="round">
            <Path d="M6 6l12 12M18 6 6 18" />
          </Svg>
          <Text style={[typography.buttonSkip, { color: colors.text.primary }]}>Skip</Text>
        </Pressable>
      </Animated.View>

      <Text style={[typography.feedProgress, { color: colors.text.tertiary }]}>{progressLabel}</Text>

      <Animated.View style={saveScale}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save"
          disabled={disabled}
          onPress={onSave}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: pressed ? colors.button.save.pressedBg : colors.button.save.bg, borderColor: colors.button.save.border },
          ]}
        >
          <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
          <Svg width={actions.saveIcon} height={actions.saveIcon} viewBox="0 0 24 24" fill="none" stroke={colors.button.save.text} strokeWidth={actions.saveIconStroke} strokeLinejoin="round">
            <Path d="M6 3h12v18l-6-4-6 4z" />
          </Svg>
          <Text style={[typography.buttonSave, { color: colors.button.save.text }]}>Save</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: actions.height,
  },
  disabled: { opacity: actions.disabledOpacity },
  button: {
    height: actions.height,
    paddingLeft: actions.paddingLeft,
    paddingRight: actions.paddingRight,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: actions.gap,
    overflow: 'hidden',
  },
});
