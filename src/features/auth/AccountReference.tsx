import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, detail, typography } from '../../theme';
import { useAuth } from './useAuth';

/**
 * The reader's account reference (EXC-XXXX-XXXX), with a button that explains it. React Native has no hover tips, so the
 * explanation opens in place. The code is derived from the Google account, never the Google account id itself.
 */
export function AccountReference() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  if (!auth || auth.state.kind !== 'approved' || auth.accountRef === null) return null;

  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <View style={styles.text}>
          <Text style={[typography.peopleName, { color: colors.text.primary }]}>Account reference</Text>
          <Text selectable style={[typography.peopleIndustry, styles.code, { color: colors.detail.peopleIndustry }]}>
            {auth.accountRef}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About the account reference"
          accessibilityState={{ expanded: open }}
          hitSlop={8}
          onPress={() => setOpen(!open)}
          style={styles.info}
        >
          <Text style={[typography.pillButton, { color: colors.text.primary }]}>?</Text>
        </Pressable>
      </View>
      {open && (
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>
          This code identifies your Excerp account. Quote it if you contact us about your data, so we can find it without asking for more. It
          cannot be used to sign in or to see your data, and it does not reveal your Google or Apple account details.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 10,
    paddingVertical: detail.peopleRowPaddingV + 2,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
  },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { flex: 1, gap: detail.peopleTextGap },
  code: { letterSpacing: 1 },
  info: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
