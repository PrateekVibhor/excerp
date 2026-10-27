import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { SettingsPatch, SocialApi } from '../../data/socialApi';
import { colors, detail, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { ConfirmVisibilitySheet } from './ConfirmVisibilitySheet';
import { explain } from './explain';
import { useMessagingSettings } from './useMessagingSettings';
import { useSocialApi } from './useSocialApi';

/**
 * Profile: the two switches that decide whether other readers can see this reader and write to them, a list of readers they have
 * blocked, and the Terms. Both are off until the reader turns them on, and the first time they confirm they are 18 or older and
 * accept the Terms. Nothing at all with no sign-in (mock data), where there are no other readers.
 */
export function MessagingSettingsCard({ social: override, browser }: { social?: SocialApi | null; browser?: Parameters<typeof openOriginal>[1] }) {
  const social = useSocialApi(override);
  const router = useRouter();
  const { status, settings, busy, update } = useMessagingSettings(social);
  const [asking, setAsking] = useState<SettingsPatch | null>(null);
  const [error, setError] = useState<string | undefined>();
  if (!social) return null;

  const confirmed = settings?.adult_confirmed === true && settings.terms_accepted === true;
  const apply = async (patch: SettingsPatch, confirmNow = false) => {
    setError(undefined);
    const res = await update(confirmNow ? { ...patch, confirm_adult: true, accept_terms: true } : patch);
    if (res.kind === 'ok') setAsking(null);
    else {
      const text = explain(res);
      setError(text);
    }
  };
  const toggle = (patch: SettingsPatch) => {
    const turningOn = patch.discoverable === true || patch.accepts_messages === true;
    if (turningOn && !confirmed) {
      setError(undefined);
      setAsking(patch);
    } else void apply(patch);
  };

  const row = (label: string, hint: string, value: boolean, onChange: (next: boolean) => void, disabled: boolean) => (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={[typography.peopleName, { color: colors.text.primary }]}>{label}</Text>
        <Text style={[typography.peopleIndustry, { color: colors.detail.peopleIndustry }]}>{hint}</Text>
      </View>
      <Switch accessibilityLabel={label} value={value} disabled={disabled || busy || status !== 'ready'} onValueChange={onChange} trackColor={{ true: colors.accent.default }} />
    </View>
  );

  return (
    <View style={styles.section}>
      <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>READERS & MESSAGES</Text>
      <View style={styles.group}>
        {row('Show me as reading', 'Readers with this on can see your name, industry and interests, and that you saved or verified the same article.', settings?.discoverable === true, (next) => toggle({ discoverable: next }), false)}
        <View style={styles.divider} />
        {row(
          'Allow message requests',
          settings?.discoverable === true ? 'Readers can send you one message. You choose whether to reply.' : 'Turn on “Show me as reading” first.',
          settings?.accepts_messages === true,
          (next) => toggle({ accepts_messages: next }),
          settings?.discoverable !== true,
        )}
        <View style={styles.divider} />
        <Pressable accessibilityRole="button" accessibilityLabel="Blocked readers" onPress={() => router.push('/blocked')} style={styles.row}>
          <Text style={[typography.peopleName, { color: colors.text.primary }]}>Blocked readers</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
      {status === 'unavailable' && <Text style={[typography.formHint, { color: colors.text.tertiary }]}>Couldn't load these settings right now.</Text>}
      <ConfirmVisibilitySheet
        visible={asking !== null}
        messages={asking?.accepts_messages === true}
        busy={busy}
        error={error}
        browser={browser}
        onCancel={() => {
          setAsking(null);
          setError(undefined);
        }}
        onConfirm={() => asking && void apply(asking, true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: detail.sectionGap },
  group: { borderRadius: detail.peopleRadius, backgroundColor: colors.detail.peopleBg, borderWidth: 1, borderColor: colors.detail.peopleBorder, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: detail.peopleRowPaddingV, paddingHorizontal: detail.peopleRowPaddingH },
  text: { flex: 1, minWidth: 0, gap: detail.peopleTextGap },
  divider: { height: 1, backgroundColor: colors.detail.peopleBorder },
});
