import { BlurView } from 'expo-blur';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Polygon, Rect } from 'react-native-svg';
import type { Band, Meter } from '../../data/courseApi';
import { blur, colors, font } from '../../theme';
import { meterParts } from './listView';
import { BandIcon } from './RatingChip';

const WORD: Record<Band, string> = { strong: 'Strong', thin: 'Thin', missing: 'Missing' };

/** Diagonal stripes across a segment, drawn once its size is known (a plain tint until then). */
function Stripes() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const c = colors.course.thin;
  const step = 8;
  const bands: number[] = [];
  if (size) for (let x = -size.height; x < size.width; x += step) bands.push(x);
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      <Svg width="100%" height="100%">
        <Rect width="100%" height="100%" fill={size ? c.stripeB : c.stripeA} />
        {size && bands.map((x) => <Polygon key={x} fill={c.stripeA} points={`${x},${size.height} ${x + step / 2},${size.height} ${x + step / 2 + size.height},0 ${x + size.height},0`} />)}
      </Svg>
    </View>
  );
}

/** One bar split in proportion: solid for strong, striped for thin, a dashed outline for missing. */
function Bar({ meter, height }: { meter: Meter; height: number }) {
  const c = colors.course;
  const parts = meterParts(meter);
  const r = height / 2;
  return (
    <View style={{ flexDirection: 'row', gap: height > 8 ? 3 : 2, height }}>
      {parts.map(([band, n], i) => {
        const corners = { borderTopLeftRadius: i === 0 ? r : 2, borderBottomLeftRadius: i === 0 ? r : 2, borderTopRightRadius: i === parts.length - 1 ? r : 2, borderBottomRightRadius: i === parts.length - 1 ? r : 2 };
        const look = band === 'strong' ? { backgroundColor: c.strong.bg } : band === 'thin' ? { overflow: 'hidden' as const } : { borderWidth: 1.5, borderStyle: 'dashed' as const, borderColor: c.missing.border };
        return (
          <View key={band} testID={`meter-${band}`} style={[{ flex: n }, corners, look]}>
            {band === 'thin' && <Stripes />}
          </View>
        );
      })}
    </View>
  );
}

const sentence = (m: Meter) => `Coverage: ${m.strong} strong, ${m.thin} thin, ${m.missing} missing`;

/** The coverage meter of a list course: the bar, then each rating's count. `compact` is the small copy that sits in the header once the full one scrolls away. */
export function CoverageMeter({ meter, compact = false }: { meter: Meter; compact?: boolean }) {
  if (compact) {
    return (
      <View accessible accessibilityLabel={sentence(meter)} style={styles.compact}>
        <View style={{ width: 90 }}><Bar meter={meter} height={6} /></View>
        <Text style={styles.compactCounts}>{`${meter.strong}·${meter.thin}·${meter.missing}`}</Text>
      </View>
    );
  }
  return (
    <View accessible accessibilityLabel={sentence(meter)} style={styles.card}>
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.head}>
        <Text style={styles.kicker}>COVERAGE</Text>
        <Text style={styles.total}>{`${meter.total} concepts`}</Text>
      </View>
      <Bar meter={meter} height={10} />
      <View style={styles.counts}>
        {(['strong', 'thin', 'missing'] as Band[]).map((band) => (
          <View key={band} style={styles.count}>
            <BandIcon band={band} size={16} />
            <Text style={styles.number}>{String(meter[band])}</Text>
            <Text style={styles.total}>{WORD[band]}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 22, gap: 12, backgroundColor: colors.glass.surface, borderWidth: 1, borderColor: colors.detail.summaryBorder, overflow: 'hidden' },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  kicker: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.kicker },
  total: { fontFamily: font.sans.regular, fontSize: 13, color: colors.course.muted },
  counts: { flexDirection: 'row', justifyContent: 'space-between' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  number: { fontFamily: font.sans.semibold, fontSize: 18, color: colors.text.primary },
  compact: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compactCounts: { fontFamily: font.mono.regular, fontSize: 11.5, color: colors.course.muted },
});
