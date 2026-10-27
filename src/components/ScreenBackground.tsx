import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { colors } from '../theme';

const glows = [
  { id: 'violet', ...colors.glow.violet, cx: 0.1, cy: 0.05, r: 0.9 },
  { id: 'teal', ...colors.glow.teal, cx: 1, cy: 0.38, r: 0.7 },
  { id: 'indigo', ...colors.glow.indigo, cx: 0.1, cy: 1, r: 0.9 },
];

export function ScreenBackground({ children }: { children: ReactNode }) {
  return (
    <View style={styles.root}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          {glows.map((g) => (
            <RadialGradient key={g.id} id={g.id} cx={g.cx} cy={g.cy} r={g.r}>
              <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
              <Stop offset="1" stopColor={g.color} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {glows.map((g) => (
          <Rect key={g.id} width="100%" height="100%" fill={`url(#${g.id})`} />
        ))}
      </Svg>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.base },
});
