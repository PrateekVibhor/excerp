import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { aiConsentStore as defaultStore } from '../../data';
import type { AiConsentStore } from '../../data/aiConsent';
import { colors, detail, typography } from '../../theme';

/**
 * "Withdraw agreement", on Profile, only once the reader has agreed to the skills-list notice (the one that says a pasted posting goes to an AI model and skill names to a
 * web search service). It asks first; confirming clears the agreement kept on this phone, so the next Build list asks again. Lists the reader already has stay until they
 * delete them. Nothing at all before agreeing, or with no store (mock data).
 */
export function WithdrawConsentRow({ store = defaultStore, style }: { store?: AiConsentStore | null; style?: StyleProp<ViewStyle> }) {
  const [agreed, setAgreed] = useState(false);
  const [asking, setAsking] = useState(false);
  // Checked each time Profile comes into view: the reader may have agreed on the Build screen since.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void store?.hasAgreed().then((yes) => live && setAgreed(yes));
      return () => {
        live = false;
      };
    }, [store]),
  );
  if (!store || !agreed) return null;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Withdraw agreement" onPress={() => setAsking(true)} style={[styles.row, style]}>
        <View style={styles.text}>
          <Text style={[typography.peopleName, { color: colors.text.primary }]}>Skills list: outside services</Text>
          <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>You agreed to send a pasted posting to an AI model. Tap to withdraw your agreement.</Text>
        </View>
      </Pressable>
      <ConfirmDialog
        visible={asking}
        title="Withdraw your agreement?"
        body="Excerp will ask again before your next skills list is built, and nothing is sent until you agree. Lists you already have stay until you delete them."
        confirmLabel="Withdraw"
        onConfirm={() => {
          setAsking(false);
          setAgreed(false);
          void store.withdraw();
        }}
        onCancel={() => setAsking(false)}
      />
    </>
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
