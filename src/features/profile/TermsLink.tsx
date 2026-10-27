import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { TERMS_URL } from '../readers/links';

/**
 * A small gray fine-print link to the Terms of Use, the twin of the Privacy Policy link: the two sit side by side at the bottom of the Profile screen. It opens the
 * page in the in-app browser, and a page that cannot be opened is logged and never crashes the screen.
 */
export function TermsLink({ browser }: { browser?: Parameters<typeof openOriginal>[1] }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Terms of Use"
      accessibilityHint="Opens the terms of use in a browser"
      hitSlop={12}
      onPress={() => void openOriginal(TERMS_URL, browser)}
      style={styles.link}
    >
      <Text style={[typography.formHint, styles.text, { color: colors.text.tertiary }]}>Terms of Use</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  text: { textAlign: 'center', textDecorationLine: 'underline', fontSize: 12 },
});
