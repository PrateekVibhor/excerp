import { useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { colors, detail } from '../theme';
import { Sheen } from './Sheen';

/** Fades scrolled content out under the status bar and the back button. `id` must be unique on screen. */
export function TopFade({ id, height, scrollY }: { id: string; height: number; scrollY: SharedValue<number> }) {
  const [width, setWidth] = useState(0);
  // Invisible at the top of the page, full strength once the content has scrolled under it.
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollY.value / detail.topFadeRamp)),
  }));
  return (
    <Animated.View
      style={[styles.topFade, { height }, style]}
      pointerEvents="none"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 && (
        <Sheen
          id={id}
          width={width}
          height={height}
          angle={180}
          color={colors.detail.bottomFade}
          stops={[[0, 1], [0.6, 1], [1, 0]]}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topFade: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
});
