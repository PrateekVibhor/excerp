import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SocialApi } from '../../data/socialApi';
import { colors, detail, typography } from '../../theme';
import type { openOriginal } from '../article/openOriginal';
import { ConfirmVisibilitySheet } from './ConfirmVisibilitySheet';
import { explain } from './explain';
import { useMessagingSettings } from './useMessagingSettings';

/** Shown where other readers would be, to a reader who has not turned on being seen: you see others while others can see you. */
export function VisibilityPrompt({ social, message, onTurnedOn, browser }: { social: SocialApi; message: string; onTurnedOn: () => void; browser?: Parameters<typeof openOriginal>[1] }) {
  const { settings, busy, update } = useMessagingSettings(social);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const confirmed = settings?.adult_confirmed === true && settings.terms_accepted === true;

  const turnOn = async () => {
    setError(undefined);
    const res = await update(confirmed ? { discoverable: true } : { discoverable: true, confirm_adult: true, accept_terms: true });
    if (res.kind === 'ok') {
      setAsking(false);
      onTurnedOn();
    } else setError(explain(res));
  };

  return (
    <View style={styles.box}>
      <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>{message}</Text>
      {error && !asking ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Turn on Show me as reading"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => (confirmed ? void turnOn() : setAsking(true))}
        style={styles.button}
      >
        <Text style={[typography.pillButton, { color: colors.text.primary }]}>Turn on “Show me as reading”</Text>
      </Pressable>
      <ConfirmVisibilitySheet visible={asking} messages={false} busy={busy} error={error} browser={browser} onCancel={() => setAsking(false)} onConfirm={() => void turnOn()} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12, padding: detail.peopleRowPaddingH, borderRadius: detail.peopleRadius, backgroundColor: colors.detail.peopleBg, borderWidth: 1, borderColor: colors.detail.peopleBorder },
  button: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 999, backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
