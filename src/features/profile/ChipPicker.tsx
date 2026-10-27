import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, profile, typography } from '../../theme';

/** A wrapping row of toggle chips. The parent decides what a tap does, including refusing it. */
export function ChipPicker({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: readonly string[];
  onToggle: (option: string) => void;
}) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const on = selected.includes(option);
        return (
          <Pressable
            key={option}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={option}
            onPress={() => onToggle(option)}
            style={[styles.chip, on && styles.chipOn]}
          >
            <Text style={[typography.chip, { color: on ? colors.form.chipSelectedText : colors.text.secondary }]}>
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: profile.chipGap },
  chip: {
    height: profile.chipHeight,
    paddingHorizontal: profile.chipPaddingH,
    borderRadius: 999,
    justifyContent: 'center',
    backgroundColor: colors.form.chipBg,
    borderWidth: 1,
    borderColor: colors.form.chipBorder,
  },
  chipOn: { backgroundColor: colors.form.chipSelectedBg, borderColor: colors.form.chipSelectedBorder },
});
