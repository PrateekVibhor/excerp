import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { KeyboardSafeScroll } from '../../components/KeyboardSafe';
import { ScreenBackground } from '../../components/ScreenBackground';
import { aiConsentStore as defaultConsent } from '../../data';
import type { AiConsentStore } from '../../data/aiConsent';
import type { CourseApi, Options } from '../../data/courseApi';
import { colors, detail, font, profile as layout, typography } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { ConsentDialog } from './ConsentDialog';
import { startMessage } from './courseMessages';
import { useCourseApi } from './useCourseApi';

/** The longest job posting the server takes. */
export const POSTING_MAX = 4000;
const NONE = 'No industry';

function Label({ children, aside }: { children: string; aside?: string }) {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.label}>{children}</Text>
      {aside ? <Text style={styles.aside}>{aside}</Text> : null}
    </View>
  );
}

/** Asking for a list: the role, the industry (optional), the job posting (optional). */
export function IntakeScreen({ api: override, consent, browser }: { api?: CourseApi | null; consent?: AiConsentStore | null; browser?: Parameters<typeof openOriginal>[1] }) {
  const api = useCourseApi(override);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [options, setOptions] = useState<Options | 'loading' | 'failed'>('loading');
  const [role, setRole] = useState<{ name: string; label: string; available: boolean } | null>(null);
  const [industry, setIndustry] = useState<{ key: string; label: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [posting, setPosting] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Before the first list is built the reader is told where the posting goes and must agree; the agreement is kept on this phone, per account, and asked again if the wording changes.
  const agreement = consent === undefined ? defaultConsent : consent;
  const [asking, setAsking] = useState(false);
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  const load = useCallback(async () => {
    if (!api) return;
    setOptions('loading');
    const res = await api.options();
    setOptions(res.kind === 'ok' ? res.value : 'failed');
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const tooLong = posting.length > POSTING_MAX;
  const canBuild = role !== null && !tooLong && !busy;
  const start = async () => {
    if (!api || !role) return;
    setBusy(true);
    setError(null);
    const res = await api.start({ role: role.name, industry: industry?.key ?? '', text: posting });
    // Back to the Skills list tab, with the new (or already existing) list open.
    if (res.kind === 'ok') return router.replace({ pathname: '/lists', params: { open: res.value.courseId } });
    setBusy(false);
    setError(res.kind === 'unauthorized' ? 'Sign in again to build a list.' : startMessage(res));
  };
  const build = async () => {
    if (!api || !role || !canBuild) return;
    if (!(await agreement?.hasAgreed())) return setAsking(true);
    await start();
  };
  const agree = async () => {
    setAsking(false);
    await agreement?.agree();
    await start();
  };

  return (
    <ScreenBackground>
      {/* The keyboard never covers the job posting field: the body scrolls it into view, and the Build list button rides above the keyboard. */}
      <KeyboardSafeScroll
        style={styles.root}
        header={
          <View style={[styles.topBar, { paddingTop: insets.top + detail.backTop }]}>
            <BackButton onPress={goBack} />
          </View>
        }
        footer={
          <View style={styles.footer}>
            <Pressable accessibilityRole="button" accessibilityLabel="Build list" accessibilityState={{ disabled: !canBuild }} onPress={() => void build()} style={[styles.build, !canBuild && styles.buildOff]}>
              {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={[styles.buildText, !canBuild && { color: colors.form.saveDisabledText }]}>Build list</Text>}
            </Pressable>
            <ConsentDialog visible={asking} onAgree={() => void agree()} onCancel={() => setAsking(false)} openLink={(url) => openOriginal(url, browser)} />
          </View>
        }
        footerInset={insets.bottom + 24}
        contentContainerStyle={[styles.content, { paddingBottom: 24 }]}
        showsVerticalScrollIndicator={false}
      >
          <View style={styles.head}>
            <Text style={styles.title}>Build a skills list</Text>
            <Text style={styles.sub}>We list the concepts the role needs, in learning order, and rate how well we can cover each one.</Text>
          </View>

          {api === null ? (
            <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Building a skills list needs the live app and a signed-in account.</Text>
          ) : options === 'loading' ? (
            <ActivityIndicator color={colors.text.secondary} />
          ) : options === 'failed' ? (
            <View style={styles.field}>
              <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Couldn't load the roles right now.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={() => void load()} style={styles.retry}>
                <Text style={[typography.pillButton, { color: colors.text.primary }]}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.field}>
                <Label>ROLE</Label>
                <View accessible accessibilityLabel={`Role, ${role ? role.label : 'none chosen'}`} style={[styles.input, role && styles.inputOn]}>
                  <Text style={[styles.inputText, !role && { color: colors.form.placeholder }]}>{role ? role.label : 'Choose a role'}</Text>
                </View>
                <View style={styles.chips}>
                  {options.roles.map((o) => {
                    const on = role?.name === o.name;
                    return (
                      <Pressable key={o.name} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} accessibilityLabel={o.label} onPress={() => o.available && setRole(o)} style={[styles.chip, on && styles.chipOn, !o.available && styles.chipOff]}>
                        <Text style={[styles.chipText, on && { color: '#ffffff', fontFamily: font.sans.semibold }, !o.available && styles.chipTextOff]}>{o.label}</Text>
                        {!o.available && <Text style={styles.soon}>Coming soon</Text>}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.field}>
                <Label>INDUSTRY</Label>
                <Pressable accessibilityRole="button" accessibilityLabel={`Industry, ${industry?.label ?? NONE}`} accessibilityState={{ expanded: menuOpen }} onPress={() => setMenuOpen((o) => !o)} style={styles.select}>
                  <Text style={styles.inputText}>{industry?.label ?? NONE}</Text>
                  <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ transform: [{ rotate: menuOpen ? '180deg' : '0deg' }] }}>
                    <Path d="m6 9 6 6 6-6" stroke={colors.course.muted} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                </Pressable>
                {menuOpen && (
                  <View style={styles.menu}>
                    {[{ key: '', label: NONE }, ...options.industries].map((o, i) => (
                      <Pressable key={o.key || 'none'} accessibilityRole="radio" accessibilityLabel={o.label} accessibilityState={{ selected: (industry?.key ?? '') === o.key }} onPress={() => { setIndustry(o.key ? o : null); setMenuOpen(false); }} style={[styles.option, i > 0 && styles.optionDivider]}>
                        <Text style={typography.formOption}>{o.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.field}>
                <Label aside="Optional">JOB POSTING</Label>
                <TextInput
                  accessibilityLabel="Job posting"
                  multiline
                  value={posting}
                  onChangeText={setPosting}
                  placeholder="Paste a job posting here"
                  placeholderTextColor={colors.form.placeholder}
                  textAlignVertical="top"
                  style={[styles.area, tooLong && { borderColor: colors.form.error }]}
                />
                <Text style={styles.hint}>Pasting a posting adds the tools and terms it mentions.</Text>
                {posting.length > POSTING_MAX - 500 && <Text style={[styles.hint, tooLong && { color: colors.form.error }]}>{`${posting.length}/${POSTING_MAX}`}</Text>}
              </View>
              {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
            </>
          )}
      </KeyboardSafeScroll>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { paddingHorizontal: detail.backSide, flexDirection: 'row' },
  content: { paddingHorizontal: 24, paddingTop: 14, gap: 20 },
  head: { gap: 8 },
  title: { fontFamily: font.sans.semibold, fontSize: 28, lineHeight: 31, letterSpacing: -0.84, color: colors.text.primary },
  sub: { fontFamily: font.sans.regular, fontSize: 15, lineHeight: 22.5, color: colors.course.muted },
  field: { gap: 8 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.kicker },
  aside: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted },
  input: { height: 50, paddingHorizontal: 16, borderRadius: 16, justifyContent: 'center', backgroundColor: colors.form.inputBg, borderWidth: 1, borderColor: colors.border.glass },
  inputOn: { borderWidth: 1.5, borderColor: colors.accent.default },
  inputText: { fontFamily: font.sans.regular, fontSize: 15.5, color: colors.text.primary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: layout.chipGap },
  chip: { height: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.form.chipBg, borderWidth: 1, borderColor: 'rgba(11,127,113,0.18)' },
  chipOn: { backgroundColor: colors.course.strong.bg, borderColor: colors.course.strong.bg },
  chipOff: { flexDirection: 'row', alignItems: 'center', gap: 6, opacity: 0.55 },
  chipTextOff: { color: colors.course.muted },
  soon: { fontFamily: font.mono.medium, fontSize: 10, letterSpacing: 0.6, color: colors.course.muted },
  chipText: { fontFamily: font.sans.regular, fontSize: 13.5, color: colors.text.primary },
  select: { height: 50, paddingHorizontal: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.glass.surface, borderWidth: 1, borderColor: colors.border.glass },
  menu: { borderRadius: 16, backgroundColor: colors.form.menuBg, borderWidth: 1, borderColor: colors.border.glass, overflow: 'hidden' },
  option: { minHeight: layout.optionHeight, paddingHorizontal: 16, justifyContent: 'center' },
  optionDivider: { borderTopWidth: 1, borderTopColor: colors.form.menuDivider },
  area: { height: 150, padding: 14, borderRadius: 18, backgroundColor: colors.glass.surface, borderWidth: 1, borderColor: colors.border.glass, fontFamily: font.sans.regular, fontSize: 14.5, lineHeight: 21.75, color: colors.text.primary },
  hint: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted },
  retry: { alignSelf: 'flex-start', height: layout.pillHeight, paddingHorizontal: layout.pillPaddingH, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  footer: { paddingHorizontal: 24, paddingTop: 8 },
  build: { height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.course.strong.bg },
  buildOff: { backgroundColor: colors.form.saveDisabledBg },
  buildText: { fontFamily: font.sans.semibold, fontSize: 16, color: '#ffffff' },
});
