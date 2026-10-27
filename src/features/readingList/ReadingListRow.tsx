import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { brandFor, formatPublishedDate, monogramFor, tagFor } from '../feed/cardFormat';
import { blur, colors, list, radius, typography } from '../../theme';
import { VerifiedBadge } from '../quiz/VerifiedBadge';
import type { ReadingListEntry } from './useReadingList';

export function ReadingListRow({
  entry,
  onOpen,
  onRemove,
  verified = false,
}: {
  entry: ReadingListEntry;
  onOpen?: () => void;
  onRemove?: () => void;
  /** The reader has passed this article's quiz: a small check shows after the tag. */
  verified?: boolean;
}) {
  const { article, item } = entry;
  const brand = article ? brandFor(article.source_company) : null;
  const tag = article ? tagFor(article.content_type) : null;
  const saved = formatPublishedDate(item.saved_at);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={article ? `Open ${article.title}` : 'Article unavailable'}
      onPress={article ? onOpen : undefined}
      disabled={!article}
      style={styles.row}
    >
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />

      <View style={[styles.monogram, { backgroundColor: brand?.bg ?? colors.glass.tabActive }]}>
        <Text style={[typography.cardMonogram, { color: brand?.fg ?? colors.text.tertiary }]}>
          {article ? monogramFor(article.source_company) : '?'}
        </Text>
      </View>

      <View style={styles.text}>
        {article && tag ? (
          <View style={styles.companyLine}>
            <Text style={[typography.rowCompany, { color: colors.list.company, flexShrink: 1 }]} numberOfLines={1}>
              {article.source_company}
            </Text>
            <Text style={[typography.rowCompany, { color: colors.list.meta }]}>·</Text>
            <Text style={[typography.rowType, { color: tag.fg }]}>{article.content_type}</Text>
            {verified && <VerifiedBadge size="mini" />}
          </View>
        ) : null}

        <Text style={[typography.rowTitle, { color: colors.text.primary }]} numberOfLines={list.titleLines}>
          {article ? article.title : 'Article unavailable'}
        </Text>
        {!article && (
          <Text style={[typography.rowCompany, { color: colors.list.meta }]}>
            It is no longer available from the source.
          </Text>
        )}

        <View style={styles.metaLine}>
          <Text style={[typography.rowMeta, { color: colors.list.date }]}>{saved ? `Saved ${saved}` : 'Saved'}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove"
            onPress={onRemove}
            hitSlop={8}
            style={({ pressed }) => [
              styles.remove,
              { backgroundColor: pressed ? colors.button.skip.pressedBg : colors.button.skip.bg },
            ]}
          >
            <Text style={[typography.rowRemove, { color: colors.button.skip.icon }]}>Remove</Text>
          </Pressable>
        </View>
      </View>

      {article && (
        <Svg width={list.chevronWidth} height={list.chevronHeight} viewBox="0 0 8 14" style={styles.chevron}>
          <Path
            d="M1 1l6 6-6 6"
            stroke={colors.list.chevron}
            strokeWidth={list.chevronStroke}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: list.rowInnerGap,
    padding: list.rowPadding,
    borderRadius: list.rowRadius,
    borderWidth: 1,
    borderColor: colors.list.rowBorder,
    backgroundColor: colors.glass.fill,
    overflow: 'hidden',
  },
  monogram: {
    width: list.monogram,
    height: list.monogram,
    borderRadius: list.monogramRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, minWidth: 0, gap: list.textGap },
  companyLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  remove: {
    height: list.removeHeight,
    paddingHorizontal: list.removePaddingH,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.button.skip.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: { marginTop: list.chevronTop },
});
