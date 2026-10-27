import { StyleSheet, Text, View } from 'react-native';
import { colors, detail, typography } from '../../theme';
import type { VerifiedStats as Stats } from './countByTopic';
import { TopicCountRow } from './TopicCountRow';

/** The Verified section of the Profile: the total large, then a row per topic. With nothing verified yet, says how to earn a badge. */
export function VerifiedStats({ stats }: { stats: Stats }) {
  const max = Math.max(0, ...stats.byTopic.map((r) => r.count));
  return (
    <View style={styles.root}>
      <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>VERIFIED</Text>
      {stats.total === 0 ? (
        <View style={styles.card}>
          <Text style={[typography.emptyTitle, { color: colors.text.primary }]}>No verified articles yet</Text>
          <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>Open an article, take its quiz and answer every question right to earn a Verified badge.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text accessibilityLabel={`${stats.total} verified articles`} style={[typography.feedTitle, { color: colors.text.primary }]}>{stats.total}</Text>
          {stats.byTopic.map((r) => (
            <TopicCountRow key={r.topic} topic={r.topic} count={r.count} max={max} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: detail.sectionGap },
  card: {
    gap: 12,
    padding: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
  },
});
