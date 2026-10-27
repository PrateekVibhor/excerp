import { StyleSheet, Text, View } from 'react-native';
import type { LeaderboardRow as Row } from '../../data';
import { colors, detail, radius, typography } from '../../theme';

/** One place on the board: rank, name and how many articles. The reader's own row is lit in the app's teal. */
export function LeaderboardRow({ row }: { row: Row }) {
  const you = row.is_you;
  return (
    <View
      accessible
      accessibilityLabel={`${row.rank}. ${row.display_name}, ${row.count} verified${you ? ', you' : ''}`}
      style={[styles.row, you ? styles.you : styles.other]}
    >
      <View style={[styles.rank, you && styles.rankYou]}>
        <Text style={[typography.cardTag, { color: you ? colors.detail.saveText : colors.text.secondary }]}>{row.rank}</Text>
      </View>
      <Text style={[typography.peopleName, styles.name, { color: colors.text.primary }]} numberOfLines={2}>
        {row.display_name}
        {you ? '  (you)' : ''}
      </Text>
      {/* Just the number: the screen's heading says what is counted, and the row says it aloud. A caption here would squeeze the names. */}
      <Text style={[typography.feedTitle, styles.count, { color: you ? colors.detail.saveText : colors.text.primary }]}>{row.count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.peopleGap,
    minHeight: 64,
    paddingVertical: 10,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    borderWidth: 1.5,
  },
  other: { backgroundColor: colors.detail.peopleBg, borderColor: colors.detail.peopleBorder },
  you: { backgroundColor: colors.detail.saveBg, borderColor: colors.detail.saveBorder },
  rank: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass.chip,
  },
  rankYou: { backgroundColor: colors.glass.tabActive },
  name: { flex: 1 },
  count: { fontSize: 22, minWidth: 28, textAlign: 'right' },
});
