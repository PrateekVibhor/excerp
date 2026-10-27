import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { PRIVACY_POLICY_URL } from '../profile/PrivacyLink';
import { TERMS_URL } from '../readers/links';

/**
 * The notice shown before a reader's first list is built (App Store guideline 5.1.2(i): say where personal data goes, including to third-party AI, and get explicit
 * permission first). It names the services and what each receives, links to the Privacy Policy and the Terms, and agrees to nothing until "Agree and build" is tapped.
 * If the wording here changes, bump AI_CONSENT_VERSION in data/aiConsent.ts so readers are asked again.
 */
export function ConsentDialog({ visible, onAgree, onCancel, openLink = (url) => openOriginal(url) }: { visible: boolean; onAgree: () => void; onCancel: () => void; openLink?: (url: string) => unknown }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.dim}>
        <View accessibilityViewIsModal style={styles.card}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
            <Text accessibilityRole="header" style={[typography.stateTitle, { color: colors.text.primary }]}>Before we build your list</Text>
            <Text style={styles.text}>To build your list, Excerp sends information to outside services:</Text>
            <Text style={styles.point}>{'•'}  The job posting you paste is sent to an AI language model run by Nebius, the company that also hosts our server. It reads the posting to find the skills it asks for.</Text>
            <Text style={styles.point}>{'•'}  Skill and tool names taken from it, and the role, are sent to Tavily (a web search service) to find learning links.</Text>
            <Text style={styles.point}>{'•'}  Not your name, email address or account details.</Text>
            <Text style={styles.text}>Do not paste anyone else's personal information. The links in your list lead to other websites that we have not reviewed.</Text>
            <Text style={styles.text}>
              Read our{' '}
              <Text accessibilityRole="link" accessibilityLabel="Privacy Policy" onPress={() => void openLink(PRIVACY_POLICY_URL)} style={styles.link}>Privacy Policy</Text>
              {' '}and{' '}
              <Text accessibilityRole="link" accessibilityLabel="Terms of Use" onPress={() => void openLink(TERMS_URL)} style={styles.link}>Terms of Use</Text>.
            </Text>
          </ScrollView>
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" accessibilityLabel="Agree and build" onPress={onAgree} style={[styles.button, styles.agree]}>
              <Text style={[typography.pillButton, { color: '#ffffff' }]}>Agree and build</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} style={styles.button}>
              <Text style={[typography.pillButton, { color: colors.text.primary }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.sheet.dim },
  card: { maxHeight: '88%', gap: 12, padding: 22, borderRadius: 24, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  body: { gap: 10 },
  text: { fontFamily: font.sans.regular, fontSize: 14.5, lineHeight: 21, color: colors.text.secondary },
  point: { fontFamily: font.sans.regular, fontSize: 14.5, lineHeight: 21, color: colors.text.primary, paddingLeft: 4 },
  link: { color: colors.course.strong.bg, textDecorationLine: 'underline', fontFamily: font.sans.semibold },
  buttons: { gap: 8, marginTop: 4 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: colors.detail.backBorder, backgroundColor: colors.detail.backBg },
  agree: { backgroundColor: colors.course.strong.bg, borderColor: colors.course.strong.bg },
});
