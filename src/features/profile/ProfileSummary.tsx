import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '../../components/Avatar';
import { colors, profile as layout, typography } from '../../theme';

/** Up to two initials: first and last word of a name, or the first letter of a single word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return (first + last).toUpperCase();
}

/**
 * A profile on display: avatar, name, industry and interests. View-only; used for the
 * reader's own saved profile and, in the next steps, for other readers.
 */
export function ProfileSummary({
  name,
  industry,
  interests,
  tone,
  avatarId,
}: {
  name: string;
  industry: string;
  interests: readonly string[];
  tone: 0 | 1 | 2;
  avatarId: string;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Avatar initials={initialsOf(name)} tone={tone} size={layout.avatar} id={avatarId} textStyle={typography.profileInitials} />
        <Text style={[typography.profileName, styles.name, { color: colors.text.primary }]}>{name}</Text>
        <Text style={[typography.profileIndustry, { color: colors.text.secondary }]}>{industry}</Text>
      </View>
      <View style={styles.section}>
        <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>INTERESTS</Text>
        <View style={styles.chips}>
          {interests.map((interest) => (
            <View key={interest} style={styles.chip}>
              <Text style={[typography.chip, { color: colors.form.chipSelectedText }]}>{interest}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: layout.sectionGap },
  top: { alignItems: 'center', gap: layout.summaryGap, paddingTop: layout.summaryTop },
  name: { textAlign: 'center', marginTop: 4 },
  section: { gap: layout.summaryGap },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: layout.chipGap },
  chip: {
    height: layout.chipHeight,
    paddingHorizontal: layout.chipPaddingH,
    borderRadius: 999,
    justifyContent: 'center',
    backgroundColor: colors.form.chipSelectedBg,
    borderWidth: 1,
    borderColor: colors.form.chipSelectedBorder,
  },
});
