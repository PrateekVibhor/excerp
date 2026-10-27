import { BlurView } from 'expo-blur';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { blur, colors, detail } from '../theme';
import { Sheen } from './Sheen';

/** A frosted card with a soft sheen, as used for the article summary. `id` must be unique on screen. */
export function GlassCard({ id, children }: { id: string; children: ReactNode }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View style={styles.card} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      {size.width > 0 && (
        <Sheen
          id={id}
          width={size.width}
          height={size.height}
          angle={160}
          color={colors.detail.summarySheen.color}
          stops={[
            [0, colors.detail.summarySheen.opacities[0]],
            [1, colors.detail.summarySheen.opacities[1]],
          ]}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: detail.summaryPadding,
    borderRadius: detail.summaryRadius,
    gap: detail.summaryGap,
    borderWidth: 1,
    borderColor: colors.detail.summaryBorder,
    overflow: 'hidden',
  },
});
