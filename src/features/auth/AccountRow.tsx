import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, detail, typography } from '../../theme';
import { useAuth } from './useAuth';

/** The Sign out row for the Profile screen. Nothing at all when there is no sign-in (mock data), so the screen stays as it was. */
export function AccountRow() {
  const auth = useAuth();
  if (!auth || auth.state.kind !== 'approved') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sign out"
      accessibilityHint="Your profile, reading list and verified articles stay on this device"
      onPress={() => void auth.signOut()}
      style={styles.row}
    >
      <View style={styles.text}>
        <Text style={[typography.peopleName, { color: colors.text.primary }]}>Sign out</Text>
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>Your profile, reading list and verified articles stay on this device.</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    justifyContent: 'center',
    paddingVertical: detail.peopleRowPaddingV + 2,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    backgroundColor: colors.detail.peopleBg,
    borderWidth: 1,
    borderColor: colors.detail.peopleBorder,
  },
  text: { gap: detail.peopleTextGap },
});
