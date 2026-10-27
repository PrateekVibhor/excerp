import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import { useBottomClear } from '../../components/useBottomClear';
import { colors, detail, font, typography } from '../../theme';
import type { Chrome } from './chrome';
import { buildSteps, type StepState } from './listView';
import { BandIcon } from './RatingChip';

const STATE_WORD: Record<StepState, string> = { done: 'done', active: 'in progress', waiting: 'waiting' };

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <BandIcon band="strong" size={20} />;
  if (state === 'active') {
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={8.2} fill="none" stroke={colors.course.step.idle} strokeWidth={2.4} />
        <Path d="M10 1.8a8.2 8.2 0 0 1 8.2 8.2" fill="none" stroke={colors.course.strong.bg} strokeWidth={2.4} strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20">
      <Circle cx={10} cy={10} r={8.2} fill="none" stroke={colors.course.step.waiting} strokeWidth={1.6} />
    </Svg>
  );
}

/** A list course while it is found and built: the role, a progress bar and four steps. A problem replaces the reassurance at the bottom. */
export function BuildingScreen({ role, industry, stage, percent, error, note, onBack, onRetry, chrome }: {
  role: string;
  industry: string | null;
  stage: string;
  percent: number;
  /** Why the build cannot go on (a limit, too few postings, a failure), in words for the reader. */
  error?: string | null;
  /** A calm line for a list that was stopped on purpose: nothing is building and nothing went wrong, so no alert and no retry. */
  note?: string | null;
  onBack: () => void;
  /** Offered with an error that asking again could fix. */
  onRetry?: () => void;
  /** In the Skills list tab: the tab's own buttons and title in place of Back. */
  chrome?: Chrome;
}) {
  const insets = useSafeAreaInsets();
  const bottomClear = useBottomClear();
  const kicker = [role, industry?.replace(/-/g, ' ')].filter(Boolean).join(' · ').toUpperCase();
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { paddingTop: insets.top + detail.backTop }]}>
          {chrome ? chrome.left : <BackButton onPress={onBack} />}
          {chrome ? <Text numberOfLines={1} style={styles.chromeTitle}>{chrome.title ?? ''}</Text> : null}
          {chrome?.right}
        </View>
        {/* Everything below the top bar scrolls, so a long error line or large text is never cut off; under it is the room the floating tab bar needs. */}
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomClear }]} showsVerticalScrollIndicator={false}>
          <View style={styles.body}>
            <View style={styles.head}>
              <Text style={styles.kicker}>{kicker}</Text>
              <Text style={styles.title}>{note ? 'List stopped' : 'Building your list'}</Text>
              {!error && !note && <Text style={styles.expect}>Building your list, this usually takes about 10 to 15 minutes</Text>}
              <View style={styles.progress}>
                <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
                <Text style={styles.pct}>{`${pct}%`}</Text>
              </View>
            </View>
            <View style={styles.steps}>
              {buildSteps(stage).map((s, i, all) => (
                <View key={s.label} accessible accessibilityLabel={`${s.label}, ${STATE_WORD[s.state]}`} style={[styles.step, i < all.length - 1 && styles.stepDivider, s.state === 'waiting' && { opacity: 0.5 }]}>
                  <StepIcon state={s.state} />
                  <Text style={[styles.stepText, s.state === 'active' && { fontFamily: font.sans.semibold }]}>{s.label}</Text>
                  {s.state === 'done' && <Text style={styles.stepNote}>done</Text>}
                  {s.state === 'active' && !error && !note && <ActivityIndicator size="small" color={colors.course.strong.bg} />}
                </View>
              ))}
            </View>
          </View>
          <View style={styles.spacer} />
          <View style={styles.foot}>
            {error ? (
              <>
                <Text accessibilityRole="alert" style={[typography.formHint, styles.error]}>{error}</Text>
                {onRetry && (
                  <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={onRetry} style={styles.retry}>
                    <Text style={[typography.pillButton, { color: colors.text.primary }]}>Try again</Text>
                  </Pressable>
                )}
              </>
            ) : note ? (
              <Text style={styles.reassure}>{note}</Text>
            ) : (
              <Text style={styles.reassure}>This can take a few minutes. You can leave this screen; your list will be waiting under Skills list in your profile.</Text>
            )}
          </View>
        </ScrollView>
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { paddingHorizontal: detail.backSide, flexDirection: 'row', alignItems: 'center' },
  chromeTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8, fontFamily: font.sans.semibold, fontSize: 14.5, color: colors.text.primary },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  spacer: { flexGrow: 1, minHeight: 24 },
  body: { paddingHorizontal: 28, paddingTop: 36, gap: 28 },
  head: { gap: 10 },
  expect: { fontFamily: font.sans.regular, fontSize: 14, lineHeight: 20, color: colors.course.muted },
  kicker: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.kicker },
  title: { fontFamily: font.sans.semibold, fontSize: 28, lineHeight: 31, letterSpacing: -0.84, color: colors.text.primary },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  track: { flex: 1, height: 6, borderRadius: 6, backgroundColor: colors.course.track, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.course.strong.bg },
  pct: { fontFamily: font.mono.regular, fontSize: 12, color: colors.course.muted },
  steps: { paddingVertical: 6, paddingHorizontal: 18, borderRadius: 24, backgroundColor: colors.glass.surface, borderWidth: 1, borderColor: colors.detail.summaryBorder },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  stepDivider: { borderBottomWidth: 1, borderBottomColor: 'rgba(18,48,43,0.08)' },
  stepText: { flex: 1, fontFamily: font.sans.regular, fontSize: 15, color: colors.text.primary },
  stepNote: { fontFamily: font.mono.regular, fontSize: 12, color: colors.course.muted },
  foot: { paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  reassure: { textAlign: 'center', fontFamily: font.sans.regular, fontSize: 13, lineHeight: 19, color: colors.course.muted },
  error: { color: colors.form.error, textAlign: 'center' },
  retry: { minHeight: 44, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
