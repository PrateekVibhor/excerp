import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { PRIVACY_POLICY_URL } from '../profile/PrivacyLink';

/** What signing in means, said before the reader signs in: what is kept, that skips are counted, and where to read more. */
export function SignInNotice({ browser }: { browser?: Parameters<typeof openOriginal>[1] }) {
  return (
    <View style={styles.root}>
      <Text style={[typography.formHint, styles.text, { color: colors.text.tertiary }]}>
        Excerp keeps your profile, saved articles and verified articles on our server, tied to your Google or Apple account, and counts the articles you skip.
      </Text>
      <Pressable accessibilityRole="link" accessibilityLabel="How your data is used" hitSlop={12} onPress={() => void openOriginal(PRIVACY_POLICY_URL, browser)} style={styles.link}>
        <Text style={[typography.formHint, styles.text, styles.underline, { color: colors.text.tertiary }]}>How your data is used</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: 2, marginTop: 8 },
  text: { textAlign: 'center', fontSize: 12 },
  underline: { textDecorationLine: 'underline' },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
