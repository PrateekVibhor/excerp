import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';

/** Where the privacy policy is published. The store listing and the app both point here. */
export const PRIVACY_POLICY_URL = 'https://excerp.app/privacy';

/**
 * A small gray fine-print link to the privacy policy, at the very bottom of the Profile screen. It opens the page in the in-app
 * browser, and a page that cannot be opened (no network, no browser) is logged and never crashes the screen.
 */
export function PrivacyLink({ browser }: { browser?: Parameters<typeof openOriginal>[1] }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Privacy Policy"
      accessibilityHint="Opens the privacy policy in a browser"
      hitSlop={12}
      onPress={() => void openOriginal(PRIVACY_POLICY_URL, browser)}
      style={styles.link}
    >
      <Text style={[typography.formHint, styles.text, { color: colors.text.tertiary }]}>Privacy Policy</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  text: { textAlign: 'center', textDecorationLine: 'underline', fontSize: 12 },
});
