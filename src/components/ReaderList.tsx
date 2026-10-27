import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { ListReader } from '../features/readers/readerView';
import { colors, detail, list, typography } from '../theme';
import { Avatar } from './Avatar';

/** A grouped list of readers: avatar, name and industry. Tapping one opens that reader's profile. */
export function ReaderList({
  readers,
  idPrefix,
  onOpenReader,
}: {
  readers: readonly ListReader[];
  /** Keeps the avatar gradient ids unique when more than one list is on screen. */
  idPrefix: string;
  onOpenReader: (readerId: string) => void;
}) {
  return (
    <View style={styles.group}>
      {readers.map((reader, i) => (
        <Pressable
          key={reader.id}
          accessibilityRole="button"
          accessibilityLabel={`${reader.name}, ${reader.industry}`}
          onPress={() => onOpenReader(reader.id)}
          style={[styles.row, i > 0 && styles.divider]}
        >
          <Avatar
            initials={reader.avatar.initials}
            tone={reader.avatar.tone}
            size={detail.peopleAvatar}
            id={`${idPrefix}-${reader.id}`}
            textStyle={typography.peopleInitials}
          />
          <View style={styles.text}>
            <Text style={[typography.peopleName, { color: colors.text.primary }]}>{reader.name}</Text>
            <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]} numberOfLines={1}>
              {reader.detail ?? reader.industry}
            </Text>
          </View>
          <Svg width={list.chevronWidth} height={list.chevronHeight} viewBox="0 0 8 14">
            <Path
              d="M1 1l6 6-6 6"
              stroke={colors.list.chevron}
              strokeWidth={list.chevronStroke}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.peopleGap,
    paddingVertical: detail.peopleRowPaddingV,
    paddingHorizontal: detail.peopleRowPaddingH,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.detail.peopleBorder },
  text: { flex: 1, minWidth: 0, gap: detail.peopleTextGap },
});
