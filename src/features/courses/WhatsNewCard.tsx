import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font } from '../../theme';
import type { Rise } from './listView';
import { BandIcon } from './RatingChip';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The highlighted card that tells the reader a rating went up since the last visit. It can be dismissed. */
export function WhatsNewCard({ rises, since, onDismiss }: { rises: Rise[]; since: string; onDismiss: () => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.icon}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.course.kicker} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><Path d="M12 19V5M5 12l7-7 7 7" /></Svg>
      </View>
      <View style={styles.body}>
        <Text style={styles.kicker}>{since}</Text>
        {rises.map((r) => (
          <View key={r.id} style={styles.rise}>
            <Text style={styles.text}>
              {'Coverage for '}<Text style={styles.name}>{r.name}</Text>{` went from ${r.from} to ${r.to}. It now has ${r.sources} vetted source${r.sources === 1 ? '' : 's'}.`}
            </Text>
            <View style={styles.change}>
              <BandIcon band={r.from} />
              <Text style={styles.small}>{cap(r.from)}</Text>
              <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={colors.course.muted} strokeWidth={2.4} strokeLinecap="round"><Path d="M5 12h14M13 6l6 6-6 6" /></Svg>
              <BandIcon band={r.to} />
              <Text style={[styles.small, { color: colors.course.kicker, fontFamily: font.sans.semibold }]}>{cap(r.to)}</Text>
            </View>
          </View>
        ))}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss what's new" hitSlop={12} onPress={onDismiss}>
        <Text style={styles.close}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, paddingVertical: 14, borderRadius: 20, backgroundColor: colors.course.whatsNew.bg, borderWidth: 1, borderColor: colors.course.whatsNew.border },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.course.whatsNew.iconBg },
  body: { flex: 1, gap: 8 },
  kicker: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.kicker },
  rise: { gap: 6 },
  text: { fontFamily: font.sans.regular, fontSize: 14.5, lineHeight: 21, color: colors.text.primary },
  name: { fontFamily: font.sans.semibold },
  change: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted },
  close: { fontSize: 20, lineHeight: 20, color: colors.course.muted },
});
