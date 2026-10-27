import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import { useBottomClear } from '../../components/useBottomClear';
import type { CourseApi, ListHome } from '../../data/courseApi';
import { colors, detail, font, typography } from '../../theme';
import { BuildingScreen } from './BuildingScreen';
import type { Chrome } from './chrome';
import { approveOnce } from './approveOnce';
import { approveMessage, buildFailedMessage, CANCELLED_NOTE, troubleMessage } from './courseMessages';
import { CourseHomeScreen } from './CourseHomeScreen';
import { useCourseApi } from './useCourseApi';

const POLL_MS = 3000;
const ENDED = ['failed', 'cancelled', 'withdrawn'];

/**
 * One list course by id. While it is found and built it follows the progress and, when the list is waiting for approval, approves it with no extra
 * tap; a limit or too few postings is shown on the building screen. Once ready it shows the course home.
 */
export function CourseScreen({ id, api: override, chrome, checkedAt, checking, refreshKey, onSeen }: {
  id: string;
  api?: CourseApi | null;
  /** In the Skills list tab: the tab's own buttons and title in place of Back. */
  chrome?: Chrome;
  /** When the list was last checked, and whether a check is under way, for the line under its heading. */
  checkedAt?: string | null;
  checking?: boolean;
  /** Changes when something happened to the list (a check finished): it is asked for again, keeping what is on screen until the new answer arrives. */
  refreshKey?: number;
  /** Called when the reader has dismissed what is new on the list. */
  onSeen?: () => void;
}) {
  const api = useCourseApi(override);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [home, setHome] = useState<ListHome | null>(null);
  // What is wrong with the status check, and with the approval, each said by what is true; each clears by itself when a later answer shows it no longer holds.
  const [offline, setOffline] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  useEffect(() => {
    if (!api) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const res = await api.home(id);
      if (!live) return;
      if (res.kind === 'refused' && res.status === 404) return setMissing(true);
      if (res.kind !== 'ok') {
        setOffline(res.kind === 'failed' ? troubleMessage(res) : troubleMessage({}));
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }
      setOffline(null);
      setHome(res.value);
      const { status } = res.value;
      if (status !== 'awaiting_approval') setTrouble(null); // the list moved on, so a problem with approving it no longer holds
      if (status === 'ready' || ENDED.includes(status)) return;
      if (status === 'awaiting_approval') {
        // Sent once however many times this runs or however many copies of the screen watch the list; a failure is retried by the next poll.
        const done = await approveOnce(api, id);
        if (!live) return;
        if (done.kind === 'ok') setTrouble(null);
        else if (done.kind === 'refused' && done.code === 'not_awaiting_approval') setTrouble(null); // someone approved or cancelled it first: the status says which
        else if (done.kind === 'failed') setTrouble(troubleMessage(done));
        else return setBlocked(done.kind === 'unauthorized' ? 'Sign in again to build your list.' : approveMessage(done));
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, id, attempt, refreshKey]);

  const again = useCallback(() => {
    setBlocked(null);
    setTrouble(null);
    setAttempt((n) => n + 1);
  }, []);

  if (!api || missing) {
    return (
      <ScreenBackground>
        <View style={[styles.plain, { paddingTop: insets.top + detail.backTop }]}>
          {chrome ? <View style={styles.chromeRow}>{chrome.left}{chrome.right}</View> : <BackButton onPress={goBack} />}
          <Text style={[typography.stateBody, { color: colors.statePanel.body, marginTop: 24 }]}>
            {api ? "This list isn't available." : 'Skills lists need the live app and a signed-in account.'}
          </Text>
        </View>
      </ScreenBackground>
    );
  }
  if (home?.status === 'ready') return <CourseHomeScreen courseId={id} home={home} api={api} chrome={chrome} checkedAt={checkedAt} checking={checking} onSeen={onSeen} />;

  // Until the first answer arrives nothing is known about the list: say so, instead of showing the first step at 0%.
  if (home === null && blocked === null) return <Loading chrome={chrome} onBack={goBack} error={trouble ?? offline} />;
  const stopped = home?.status === 'cancelled';
  const ended = home && !stopped && ENDED.includes(home.status);
  const error = blocked ?? (ended ? buildFailedMessage(home.status) : trouble ?? offline);
  return (
    <BuildingScreen
      role={home?.role ?? ''}
      industry={home?.industry ?? null}
      stage={home && 'stage' in home ? home.stage : ''}
      percent={home && 'percent' in home ? home.percent : 0}
      error={error}
      note={stopped && !blocked ? CANCELLED_NOTE : null}
      onBack={goBack}
      onRetry={blocked ? again : undefined}
      chrome={chrome}
    />
  );
}

const styles = StyleSheet.create({
  plain: { flex: 1, paddingHorizontal: detail.backSide },
  chromeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  root: { flex: 1 },
  bar: { paddingHorizontal: detail.backSide, flexDirection: 'row', alignItems: 'center' },
  barTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8, fontFamily: font.sans.semibold, fontSize: 14.5, color: colors.text.primary },
  waiting: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 28 },
  waitError: { color: colors.form.error, textAlign: 'center' },
});

/** Shown before the first answer about the list: neither building nor failed is known yet. */
function Loading({ chrome, onBack, error }: { chrome?: Chrome; onBack: () => void; error: string | null }) {
  const insets = useSafeAreaInsets();
  const bottomClear = useBottomClear();
  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.bar, { paddingTop: insets.top + detail.backTop }]}>
          {chrome ? chrome.left : <BackButton onPress={onBack} />}
          {chrome ? <Text numberOfLines={1} style={styles.barTitle}>{chrome.title ?? ''}</Text> : null}
          {chrome?.right}
        </View>
        <View style={[styles.waiting, { paddingBottom: bottomClear }]}>
          <ActivityIndicator color={colors.text.secondary} />
          <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Loading…</Text>
          {error ? <Text accessibilityRole="alert" style={[typography.formHint, styles.waitError]}>{error}</Text> : null}
        </View>
      </View>
    </ScreenBackground>
  );
}
