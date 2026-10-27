import { StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';

/** One topic of the Verified section: its name, the count, and a thin bar scaled to the largest count (`max`). */
export function TopicCountRow({ topic, count, max }: { topic: string; count: number; max: number }) {
  const share = max > 0 ? Math.min(count / max, 1) : 0;
  return (
    <View accessible accessibilityLabel={`${topic}, ${count}`} style={styles.row}>
      <View style={styles.line}>
        <Text numberOfLines={2} style={[typography.chip, styles.name, { color: colors.text.primary }]}>{topic}</Text>
        <Text style={[typography.chip, { color: colors.text.secondary }]}>{count}</Text>
      </View>
      <View style={styles.track}>
        <View testID="topic-bar" style={[styles.fill, { width: `${share * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 6 },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  name: { flex: 1 }, // a long name wraps instead of pushing the count off the row
  track: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.detail.backBg },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.form.chipSelectedBorder },
});
