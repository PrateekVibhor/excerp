import type { TextStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { colors } from '../theme';

/**
 * Initials on a round gradient. `tone` picks one of the theme's three avatar gradients;
 * `id` must be unique on screen because the SVG gradient is referenced by it.
 */
export function Avatar({
  initials,
  tone,
  size,
  id,
  textStyle,
}: {
  initials: string;
  tone: 0 | 1 | 2;
  size: number;
  id: string;
  textStyle: TextStyle;
}) {
  const [from, to] = colors.card.avatars[tone];
  const r = size / 2;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${id})`} />
      </Svg>
      <Text style={[textStyle, { color: colors.text.primary }]}>{initials}</Text>
    </View>
  );
}
