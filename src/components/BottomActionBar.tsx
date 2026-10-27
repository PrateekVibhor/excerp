import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, detail, radius, typography } from '../theme';
import { Sheen } from './Sheen';

/**
 * A fixed bar at the bottom of a screen: one big white button and a hint line under it,
 * fading in from the page behind. `id` must be unique on screen.
 */
export function BottomActionBar({
  id,
  label,
  hint,
  icon,
  bottomInset,
  onPress,
  onHeight,
}: {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  bottomInset: number;
  onPress: () => void;
  /** Told the bar's real height (button, hint and the bottom inset) whenever it is laid out, so a screen can leave exactly that much room under its content. */
  onHeight?: (height: number) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      style={[styles.bottom, { paddingBottom: bottomInset + detail.bottomPaddingBottom }]}
      pointerEvents="box-none"
      onLayout={(e) => {
        setSize(e.nativeEvent.layout);
        onHeight?.(e.nativeEvent.layout.height);
      }}
    >
      {size.width > 0 && (
        <Sheen
          id={id}
          width={size.width}
          height={size.height}
          angle={0}
          color={colors.detail.bottomFade}
          stops={[[0, 1], [0.55, 1], [1, 0]]}
        />
      )}
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
        <Text style={[typography.openOriginal, { color: colors.detail.openText }]}>{label}</Text>
        {icon}
      </Pressable>
      <Text style={[typography.openHint, { color: colors.detail.openHint }]}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: detail.bottomPaddingTop,
    paddingHorizontal: detail.bottomSide,
    gap: detail.bottomGap,
    alignItems: 'center',
  },
  button: {
    width: '100%',
    minHeight: detail.openHeight,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.detail.openBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: detail.openGap,
    shadowColor: colors.detail.openGlow,
    shadowOpacity: 1,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 12 },
  },
});
