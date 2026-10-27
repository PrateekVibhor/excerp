import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Band } from '../../data/courseApi';
import { colors, font } from '../../theme';

/** The rating's own mark: a filled circle with a check, a half-filled circle, or a dashed empty one. `inverted` is the strong mark on a solid chip. */
export function BandIcon({ band, size = 14, inverted = false }: { band: Band; size?: number; inverted?: boolean }) {
  const c = colors.course;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      {band === 'strong' && (
        <>
          <Circle cx={10} cy={10} r={9} fill={inverted ? '#ffffff' : c.strong.bg} />
          <Path d="m6 10.2 2.7 2.6L14 7.6" fill="none" stroke={inverted ? c.strong.bg : '#ffffff'} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {band === 'thin' && (
        <>
          <Circle cx={10} cy={10} r={8.2} fill="none" stroke={c.thin.fg} strokeWidth={1.8} />
          <Path d="M10 1.8a8.2 8.2 0 0 1 0 16.4z" fill={c.thin.fg} />
        </>
      )}
      {band === 'missing' && <Circle cx={10} cy={10} r={8.2} fill="none" stroke={c.missing.fg} strokeWidth={1.8} strokeDasharray="3 2.4" />}
    </Svg>
  );
}

/** A 26pt pill that says how well a concept is covered. The shape and the word carry the meaning, so it reads in grayscale. */
export function RatingChip({ band }: { band: Band }) {
  const c = colors.course;
  const look = band === 'strong' ? { backgroundColor: c.strong.bg, color: c.strong.fg } : band === 'thin' ? { backgroundColor: c.thin.bg, color: c.thin.fg } : { color: c.missing.fg };
  return (
    <View accessible accessibilityLabel={`Coverage: ${band}`} style={[styles.chip, band === 'missing' && styles.dashed, band !== 'missing' && { backgroundColor: look.backgroundColor }]}>
      <BandIcon band={band} inverted={band === 'strong'} />
      <Text style={[styles.word, { color: look.color }]}>{band.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { height: 26, paddingLeft: 6, paddingRight: 9, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 5 },
  dashed: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.course.missing.border },
  word: { fontFamily: font.mono.medium, fontSize: 11 },
});
