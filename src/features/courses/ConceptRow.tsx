import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { ListConcept } from '../../data/courseApi';
import { colors, font } from '../../theme';
import { bandNote, resourceRow } from './listView';
import { RatingChip } from './RatingChip';

function Chevron({ up }: { up: boolean }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={colors.course.muted} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </Svg>
  );
}
const Shield = () => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.course.library.fg} strokeWidth={2} strokeLinejoin="round">
    <Path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" fill={colors.course.library.shield} />
    <Path d="m8.5 12 2.5 2.5 4.5-5" strokeLinecap="round" />
  </Svg>
);
const LinkIcon = () => (
  <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.course.web.icon} strokeWidth={2} strokeLinecap="round">
    <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <Path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);

/** One concept in the list: number, name and rating; opened, its links (library sources marked, web links plain) and what the rating means. */
export function ConceptRow({ concept, index, count, open, onToggle, onOpenLink }: {
  concept: ListConcept;
  index: number;
  count: number;
  open: boolean;
  onToggle: () => void;
  onOpenLink: (url: string) => void;
}) {
  const note = bandNote(concept.band, concept.resources);
  return (
    <View style={[styles.card, open ? styles.cardOpen : styles.cardClosed]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${concept.displayName}, ${concept.band}, ${index + 1} of ${count}`} accessibilityState={{ expanded: open }} onPress={onToggle} style={styles.head}>
        <Text style={styles.number}>{String(index + 1).padStart(2, '0')}</Text>
        <Text style={[styles.name, open && { fontFamily: font.sans.semibold, fontSize: 15.5 }]}>{concept.displayName}</Text>
        <RatingChip band={concept.band} />
        <Chevron up={open} />
      </Pressable>
      {open && (
        <View style={styles.links}>
          {note && concept.band === 'missing' && <Text style={[styles.note, styles.emptyNote]}>{note}</Text>}
          {concept.resources.map((r) => {
            const row = resourceRow(r);
            return row.vetted ? (
              <Pressable key={r.url} accessibilityRole="link" accessibilityLabel={`${row.title}, library source`} onPress={() => onOpenLink(r.url)} style={styles.library}>
                <Shield />
                <View style={styles.linkText}>
                  <Text style={styles.libraryTitle}>{row.title}</Text>
                  <Text style={styles.libraryLabel}>{row.label}</Text>
                </View>
              </Pressable>
            ) : (
              <Pressable key={r.url} accessibilityRole="link" accessibilityLabel={`${row.title}, web link, not reviewed`} onPress={() => onOpenLink(r.url)} style={styles.web}>
                <LinkIcon />
                <Text style={styles.webTitle}>{row.title}<Text style={styles.webLabel}>{` · ${row.label}`}</Text></Text>
              </Pressable>
            );
          })}
          {note && concept.band !== 'missing' && <Text style={styles.note}>{note}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20 },
  cardOpen: { padding: 14, gap: 12, backgroundColor: colors.course.openCard.bg, borderWidth: 1, borderColor: colors.course.openCard.border },
  cardClosed: { backgroundColor: colors.course.row, borderRadius: 18 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2, paddingHorizontal: 0, minHeight: 44 },
  number: { width: 20, fontFamily: font.mono.regular, fontSize: 12, color: colors.course.muted },
  name: { flex: 1, fontFamily: font.sans.medium, fontSize: 15, color: colors.text.primary },
  links: { gap: 6, paddingLeft: 30 },
  library: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.course.library.bg },
  linkText: { flex: 1, minWidth: 0, gap: 2 },
  libraryTitle: { fontFamily: font.sans.semibold, fontSize: 14, color: colors.text.primary },
  libraryLabel: { fontFamily: font.mono.regular, fontSize: 11, color: colors.course.library.fg },
  web: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12 },
  webTitle: { flex: 1, minWidth: 0, fontFamily: font.sans.regular, fontSize: 13.5, color: colors.course.web.text },
  webLabel: { fontFamily: font.mono.regular, fontSize: 11 },
  note: { fontFamily: font.sans.regular, fontSize: 12.5, lineHeight: 18, color: colors.course.muted, paddingTop: 2, paddingHorizontal: 12 },
  emptyNote: { padding: 12, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.course.note.border, fontSize: 13.5, lineHeight: 19.5 },
});
