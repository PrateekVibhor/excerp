import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import type { MyList } from '../../data/courseApi';
import { colors, font, typography } from '../../theme';
import { ActionMenu } from './ActionMenu';
import { CoverageMeter } from './CoverageMeter';
import { groupLists, listStarted, listTitle, statusLabel } from './listTitles';

const SLIDE_MS = 220;

/**
 * The reader's lists, in a panel that slides in from the left (opened by the hamburger, never by a swipe from the edge, which the Feed's card swipes could
 * share): a New list button, then every list grouped by when it was last used, each with its status or mini coverage and a dot for new coverage.
 */
export function ListsPanel({ visible, status, lists, activeId, now, timeZone, onClose, onNew, onSelect, onRename, onDelete, onRetry }: {
  visible: boolean;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  lists: MyList[];
  activeId: string | null;
  now?: Date;
  timeZone?: string;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (list: MyList) => void;
  onDelete: (list: MyList) => void;
  onRetry: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, Math.round(width * 0.86));
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(visible);
  const [menuFor, setMenuFor] = useState<MyList | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.value = withTiming(1, { duration: SLIDE_MS });
    } else {
      progress.value = withTiming(0, { duration: SLIDE_MS }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [visible, progress]);

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (progress.value - 1) * panelWidth }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  if (!mounted && !visible) return null;

  const groups = groupLists(lists, now ?? new Date(), timeZone);
  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close panel" onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View accessibilityViewIsModal style={[styles.panel, { width: panelWidth, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }, panelStyle]}>
        <View style={styles.head}>
          <Text style={styles.title}>Skills lists</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close lists" hitSlop={10} onPress={onClose} style={styles.close}>
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.text.primary} strokeWidth={2.6} strokeLinecap="round"><Path d="M6 6l12 12M18 6 6 18" /></Svg>
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="New list" onPress={onNew} style={styles.newList}>
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.6} strokeLinecap="round"><Path d="M12 5v14M5 12h14" /></Svg>
          <Text style={styles.newListText}>New list</Text>
        </Pressable>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {status === 'loading' && <ActivityIndicator color={colors.text.secondary} style={{ marginTop: 24 }} />}
          {status === 'unavailable' && (
            <View style={styles.note}>
              <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Couldn't load your lists right now.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} style={styles.retry}>
                <Text style={[typography.pillButton, { color: colors.text.primary }]}>Retry</Text>
              </Pressable>
            </View>
          )}
          {status === 'ready' && lists.length === 0 && <Text style={[typography.stateBody, styles.note, { color: colors.statePanel.body }]}>No lists yet. Build your first one.</Text>}
          {groups.map((g) => (
            <View key={g.title} style={styles.group}>
              <Text style={styles.groupTitle}>{g.title.toUpperCase()}</Text>
              {g.lists.map((l) => {
                const title = listTitle(l, undefined, timeZone);
                const started = listStarted(l, undefined, timeZone);
                const active = l.id === activeId;
                const state = statusLabel(l);
                return (
                  <View key={l.id} style={[styles.row, active && styles.rowActive]}>
                    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ selected: active }} onPress={() => onSelect(l.id)} style={styles.rowMain}>
                      <View style={styles.rowTop}>
                        <Text numberOfLines={1} style={[styles.rowTitle, active && { fontFamily: font.sans.semibold }]}>{title}</Text>
                        {l.hasUpdates && <View accessible accessibilityLabel="New coverage" style={styles.dot} />}
                      </View>
                      {started ? <Text style={styles.started}>{started}</Text> : null}
                      {state ? <Text style={styles.status}>{state}</Text> : l.coverage ? <CoverageMeter meter={l.coverage} compact /> : <Text style={styles.status}>Ready</Text>}
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${title}`} hitSlop={8} onPress={() => setMenuFor(l)} style={styles.more}>
                      <Svg width={18} height={18} viewBox="0 0 24 24" fill={colors.course.muted}><Path d="M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" /></Svg>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </Animated.View>
      <ActionMenu
        visible={menuFor !== null}
        title={menuFor ? listTitle(menuFor, undefined, timeZone) : undefined}
        items={menuFor ? [{ label: 'Rename', onPress: () => onRename(menuFor) }, { label: 'Delete', destructive: true, onPress: () => onDelete(menuFor) }] : []}
        onClose={() => setMenuFor(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, zIndex: 50 },
  backdrop: { backgroundColor: colors.sheet.dim },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0, paddingHorizontal: 14, gap: 12, backgroundColor: colors.bg.base, borderRightWidth: 1, borderRightColor: colors.border.glass },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  title: { fontFamily: font.sans.semibold, fontSize: 22, letterSpacing: -0.4, color: colors.text.primary },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  newList: { height: 48, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.course.strong.bg },
  newListText: { fontFamily: font.sans.semibold, fontSize: 15.5, color: '#ffffff' },
  scroll: { flex: 1 },
  content: { gap: 14, paddingBottom: 24 },
  group: { gap: 4 },
  groupTitle: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.muted, paddingHorizontal: 8, paddingBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: 16 },
  rowActive: { backgroundColor: colors.course.library.bg },
  rowMain: { flex: 1, minHeight: 56, paddingHorizontal: 10, paddingVertical: 9, gap: 5 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, fontFamily: font.sans.medium, fontSize: 15, color: colors.text.primary },
  started: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted, marginTop: 1, marginBottom: 3 },
  status: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent.default },
  more: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  note: { paddingHorizontal: 8, gap: 10 },
  retry: { alignSelf: 'flex-start', height: 40, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
