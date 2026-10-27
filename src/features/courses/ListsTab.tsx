import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ScreenBackground } from '../../components/ScreenBackground';
import { Toast } from '../../components/Toast';
import { useToast } from '../../components/useToast';
import { lastListStore as defaultLast, listsStore as defaultStore } from '../../data';
import type { CourseApi, MyList } from '../../data/courseApi';
import type { LastListStore } from '../../data/lastList';
import type { ListsStore } from '../../data/listsStore';
import { colors, detail, font, typography } from '../../theme';
import { ActionMenu } from './ActionMenu';
import { cancelMessage, deleteMessage, refreshFailedMessage, renameMessage } from './courseMessages';
import { CourseScreen } from './CourseScreen';
import { ListsPanel } from './ListsPanel';
import { checkedLabel, listTitle, refreshLimitMessage } from './listTitles';
import { RenameDialog } from './RenameDialog';
import { useCourseApi } from './useCourseApi';
import { useListsSnapshot } from './useLists';

const POLL_MS = 3000;

function CircleButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.circle}>
      {children}
    </Pressable>
  );
}
const Hamburger = () => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.text.primary} strokeWidth={2.4} strokeLinecap="round"><Path d="M4 7h16M4 12h16M4 17h16" /></Svg>
);
const Dots = () => (
  <Svg width={20} height={20} viewBox="0 0 24 24" fill={colors.text.primary}><Path d="M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" /></Svg>
);

/**
 * The Skills list tab: the list the reader used last (or the most recent), with a hamburger that opens the panel of all their lists, and a menu to rename, check for new
 * sources or delete the open list. A reader with no list is invited to build the first.
 */
export function ListsTab({ api: override, store: storeOverride, last: lastOverride }: { api?: CourseApi | null; store?: ListsStore | null; last?: LastListStore }) {
  const api = useCourseApi(override);
  const store = storeOverride === undefined ? defaultStore : storeOverride;
  const last = lastOverride ?? defaultLast;
  const snap = useListsSnapshot(store);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { open: openParam } = useLocalSearchParams<{ open?: string }>();
  const toast = useToast(3600);

  const [choice, setChoice] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<{ list: MyList; busy: boolean; error?: string } | null>(null);
  const [deleting, setDeleting] = useState<{ list: MyList; busy: boolean; error?: string } | null>(null);
  const [stopping, setStopping] = useState<{ list: MyList; busy: boolean; error?: string } | null>(null);
  const stopSent = useRef(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [applied, setApplied] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void last.get().then((id) => live && setRemembered(id));
    return () => {
      live = false;
    };
  }, [last]);
  useFocusEffect(useCallback(() => { void store?.refresh(); }, [store]));

  // A list the reader was just sent to (the one they started) opens, once, as soon as it is among their lists; until it is, a spinner shows instead of some other list.
  const sentTo = openParam && openParam !== applied ? openParam : undefined;
  const arrived = sentTo !== undefined && snap.lists.some((l) => l.id === sentTo);
  useEffect(() => {
    if (sentTo === undefined) return;
    // Done with it once it has arrived, or once the lists have been asked for and it is still not there (then the lists are shown as they are).
    const settle = () => {
      if (store?.get().lists.some((l) => l.id === sentTo)) {
        setChoice(sentTo);
        void last.set(sentTo);
      }
      setApplied(sentTo);
    };
    if (arrived || !store) settle();
    else void store.refresh().finally(settle);
  }, [sentTo, arrived, store, last]);

  const wanted = arrived ? sentTo : choice ?? remembered;
  const active = snap.lists.find((l) => l.id === wanted) ?? snap.lists[0] ?? null;
  const waitingForSent = sentTo !== undefined && !arrived;

  // While a check is under way the lists are asked for every few seconds; when it ends the reader is told and the list is read again.
  const refreshing = active?.refreshing === true;
  useEffect(() => {
    if (!refreshing || !store) return;
    const timer = setInterval(() => void store.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshing, store]);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !refreshing) {
      toast.show(active?.hasUpdates ? 'New coverage found' : 'Checked just now');
      setRefreshKey((k) => k + 1);
    }
    wasRefreshing.current = refreshing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing]);

  const select = (id: string) => {
    setPanel(false);
    setChoice(id);
    void api?.open(id);
    store?.touch(id, new Date().toISOString());
    void last.set(id);
  };
  const startNew = () => {
    setPanel(false);
    router.push('/courses/new');
  };

  const saveName = async (title: string) => {
    if (!api || !renaming) return;
    const target = renaming.list;
    setRenaming({ list: target, busy: true });
    const res = await api.rename(target.id, title === '' ? null : title);
    if (res.kind === 'ok') {
      store?.patch(target.id, { customTitle: title === '' ? null : title });
      setRenaming(null);
    } else if (res.kind === 'refused' && res.status === 404) {
      store?.drop(target.id);
      setRenaming(null);
    } else {
      setRenaming({ list: target, busy: false, error: res.kind === 'unauthorized' ? 'Sign in again to rename lists.' : renameMessage(res) });
    }
  };

  const confirmDelete = async () => {
    if (!api || !deleting) return;
    const target = deleting.list;
    setDeleting({ list: target, busy: true });
    const res = await api.remove(target.id);
    if (res.kind === 'ok' || (res.kind === 'refused' && res.status === 404)) {
      store?.drop(target.id);
      if (target.id === active?.id || target.id === remembered) {
        setChoice(null);
        setRemembered(null);
        void last.clear();
      }
      setDeleting(null);
    } else {
      setDeleting({ list: target, busy: false, error: res.kind === 'unauthorized' ? 'Sign in again to delete lists.' : deleteMessage(res) });
    }
  };

  const confirmStop = async () => {
    if (!api || !stopping || stopSent.current) return; // one cancel per tap of Stop building, however fast it is tapped
    stopSent.current = true;
    const target = stopping.list;
    setStopping({ list: target, busy: true });
    const res = await api.cancel(target.id);
    stopSent.current = false;
    if (res.kind === 'ok') {
      store?.patch(target.id, { status: 'cancelled' });
    } else if (res.kind === 'refused' && res.status === 404) {
      store?.drop(target.id);
    } else if (res.kind === 'refused' && res.code === 'not_cancellable') {
      void store?.refresh(); // it finished or failed first: the status says which, with nothing to be alarmed about
    } else {
      return setStopping({ list: target, busy: false, error: res.kind === 'unauthorized' ? 'Sign in again to stop lists.' : cancelMessage(res) });
    }
    setStopping(null);
    setRefreshKey((k) => k + 1);
  };

  const refreshNow = async () => {
    if (!api || !active) return;
    const res = await api.refresh(active.id);
    if (res.kind === 'ok') {
      if (res.value.status === 'up_to_date') {
        store?.patch(active.id, { checkedAt: new Date().toISOString() });
        toast.show('Up to date');
      } else {
        store?.patch(active.id, { refreshing: true });
      }
    } else if (res.kind === 'refused' && res.code === 'refresh_limit') {
      toast.show(refreshLimitMessage(res.retryAt));
    } else {
      toast.show(res.kind === 'unauthorized' ? 'Sign in again to check lists.' : refreshFailedMessage(res));
    }
  };

  const hamburger = <CircleButton label="Open lists" onPress={() => setPanel(true)}><Hamburger /></CircleButton>;
  const topBar = (extra?: React.ReactNode) => (
    <View style={[styles.topBar, { paddingTop: insets.top + detail.backTop }]}>
      {hamburger}
      <View style={styles.spacer} />
      {extra}
    </View>
  );

  let body: React.ReactNode;
  if (!api) {
    body = <View style={styles.center}><Text style={[typography.stateBody, styles.centerText]}>Skills lists need the live app and a signed-in account.</Text></View>;
  } else if (snap.status === 'idle' || snap.status === 'loading' || waitingForSent) {
    body = <View style={styles.center}><ActivityIndicator color={colors.text.secondary} /></View>;
  } else if (snap.status === 'unavailable' && snap.lists.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={[typography.stateBody, styles.centerText]}>Couldn't load your lists right now.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={() => void store?.refresh()} style={styles.pill}>
          <Text style={[typography.pillButton, { color: colors.text.primary }]}>Retry</Text>
        </Pressable>
      </View>
    );
  } else if (!active) {
    body = (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No skills lists yet</Text>
        <Text style={[typography.stateBody, styles.centerText]}>Pick a role, paste a job posting if you have one, and we'll list what to learn, in order.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Build your first skills list" onPress={startNew} style={styles.cta}>
          <Text style={styles.ctaText}>Build your first skills list</Text>
        </Pressable>
      </View>
    );
  } else {
    body = (
      <CourseScreen
        key={active.id}
        id={active.id}
        api={api}
        refreshKey={refreshKey}
        checkedAt={active.checkedAt}
        checking={active.refreshing}
        onSeen={() => store?.patch(active.id, { hasUpdates: false })}
        chrome={{ title: listTitle(active), left: hamburger, right: <CircleButton label="List options" onPress={() => setMenu(true)}><Dots /></CircleButton> }}
      />
    );
  }

  const ready = active?.status === 'ready';
  const stoppable = active !== null && ['finding_sources', 'awaiting_approval', 'building'].includes(active.status);
  return (
    <ScreenBackground>
      <View style={styles.root}>
        {body}
        {!active || !api ? topBar() : null}
        <ListsPanel
          visible={panel}
          status={snap.status}
          lists={snap.lists}
          activeId={active?.id ?? null}
          onClose={() => setPanel(false)}
          onNew={startNew}
          onSelect={select}
          onRename={(l) => setRenaming({ list: l, busy: false })}
          onDelete={(l) => setDeleting({ list: l, busy: false })}
          onRetry={() => void store?.refresh()}
        />
        <ActionMenu
          visible={menu && active !== null}
          title={active ? listTitle(active) : undefined}
          items={active ? [
            { label: 'Rename', onPress: () => setRenaming({ list: active, busy: false }) },
            { label: 'Refresh now', onPress: () => void refreshNow(), disabled: !ready || active.refreshing, hint: active.refreshing ? 'Checking for new sources…' : ready ? checkedLabel(active.checkedAt, new Date()) : 'Available once the list is ready' },
            ...(stoppable ? [{ label: 'Cancel build', onPress: () => setStopping({ list: active, busy: false }) }] : []),
            { label: 'Delete', destructive: true, onPress: () => setDeleting({ list: active, busy: false }) },
          ] : []}
          onClose={() => setMenu(false)}
        />
        <RenameDialog visible={renaming !== null} initial={renaming ? listTitle(renaming.list) : ''} busy={renaming?.busy} error={renaming?.error} onSave={(t) => void saveName(t)} onCancel={() => setRenaming(null)} />
        <ConfirmDialog
          visible={deleting !== null}
          title={deleting?.list.visibility === 'shared' ? 'Remove this list?' : 'Delete this list?'}
          body={deleting?.list.visibility === 'shared' ? 'This only removes it from your lists. Other readers keep it, and you can add it again later.' : "This deletes the list and the job posting you pasted for it. It can't be undone."}
          confirmLabel={deleting?.list.visibility === 'shared' ? 'Remove list' : 'Delete list'}
          destructive
          busy={deleting?.busy}
          error={deleting?.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
        <ConfirmDialog
          visible={stopping !== null}
          title="Stop building this list?"
          body="Nothing more is built. The list stays in your lists until you delete it."
          confirmLabel={stopping?.busy ? 'Stopping…' : 'Stop building'}
          cancelLabel="Keep building"
          destructive
          busy={stopping?.busy}
          error={stopping?.error}
          onConfirm={() => void confirmStop()}
          onCancel={() => setStopping(null)}
        />
        <Toast message={toast.message} />
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: detail.backSide, flexDirection: 'row', alignItems: 'center' },
  spacer: { flex: 1 },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14 },
  centerText: { color: colors.statePanel.body, textAlign: 'center' },
  emptyTitle: { fontFamily: font.sans.semibold, fontSize: 24, letterSpacing: -0.5, color: colors.text.primary, textAlign: 'center' },
  cta: { marginTop: 6, height: 54, paddingHorizontal: 26, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.course.strong.bg },
  ctaText: { fontFamily: font.sans.semibold, fontSize: 16, color: '#ffffff' },
  pill: { height: 40, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
