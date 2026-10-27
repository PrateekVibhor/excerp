import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import { useBottomClear } from '../../components/useBottomClear';
import type { CourseApi, ReadyList } from '../../data/courseApi';
import { colors, detail, font } from '../../theme';
import { openOriginal } from '../article/openOriginal';
import { ConceptRow } from './ConceptRow';
import { CoverageMeter } from './CoverageMeter';
import type { Chrome } from './chrome';
import { checkedLabel } from './listTitles';
import { evidenceNote, newest, oldestDate, sinceLabel, whatsNew, type Rise } from './listView';
import { WhatsNewCard } from './WhatsNewCard';

/** How far the page scrolls before the full meter is out of sight and the compact copy takes over in the header. */
const COMPACT_AFTER = 220;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A ready list course: what is new, the coverage meter, then the concepts in learning order with their links. */
export function CourseHomeScreen({ courseId, home, api, openLink = openOriginal, chrome, checkedAt, checking, onSeen }: {
  courseId: string;
  home: ReadyList;
  api: CourseApi;
  /** Opens a resource; a test hands in its own. */
  openLink?: (url: string) => Promise<boolean>;
  /** In the Skills list tab: the tab's own buttons and title at the top, in place of Back. */
  chrome?: Chrome;
  /** When the list was last checked for new sources (null: never). Left out, no checked line is shown. */
  checkedAt?: string | null;
  /** A check the reader asked for is under way. */
  checking?: boolean;
  /** Called when the reader has dismissed what is new (so a dot elsewhere can go). */
  onSeen?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bottomClear = useBottomClear();
  const router = useRouter();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));
  const [open, setOpen] = useState<Set<string>>(() => new Set(home.concepts.slice(0, 1).map((c) => c.id)));
  const [compact, setCompact] = useState(false);
  const [news, setNews] = useState<{ rises: Rise[]; since: string; version: number } | null>(null);

  useEffect(() => {
    if (!home.hasUpdates) return;
    let live = true;
    void api.changes(courseId, home.seenVersion).then((res) => {
      if (!live || res.kind !== 'ok') return;
      const rises = whatsNew(res.value.changes);
      if (rises.length) setNews({ rises, since: sinceLabel(oldestDate(res.value.changes)), version: newest(res.value.changes) || res.value.currentVersion });
    });
    return () => {
      live = false;
    };
  }, [api, courseId, home.hasUpdates, home.seenVersion]);

  const dismiss = () => {
    if (news) void api.seen(courseId, news.version);
    setNews(null);
    onSeen?.();
  };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => setCompact(e.nativeEvent.contentOffset.y > COMPACT_AFTER);
  const thinNote = evidenceNote(home.evidence);
  const sub = [home.industryLabel, `${home.concepts.length} concepts`].filter(Boolean).join(' · ');

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { paddingTop: insets.top + detail.backTop }]}>
          {chrome ? chrome.left : <BackButton onPress={goBack} />}
          <Text numberOfLines={1} style={[styles.mode, chrome && styles.modeTitle]}>{chrome?.title ?? 'LIST COURSE'}</Text>
          {chrome ? chrome.right ?? <View style={styles.spacer} /> : <View style={styles.spacer} />}
        </View>
        {compact && (
          <View style={styles.compact}>
            <Text style={styles.compactName}>{cap(home.role)}</Text>
            <CoverageMeter meter={home.coverage} compact />
          </View>
        )}
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: bottomClear }]} onScroll={onScroll} scrollEventThrottle={16} showsVerticalScrollIndicator={false}>
          <View style={styles.head}>
            <Text style={styles.title}>{cap(home.role)}</Text>
            <Text style={styles.sub}>{sub}</Text>
            {(checking || checkedAt !== undefined) && <Text style={styles.sub}>{checking ? 'Checking for new sources…' : checkedLabel(checkedAt ?? null, new Date())}</Text>}
          </View>
          {news && <WhatsNewCard rises={news.rises} since={news.since} onDismiss={dismiss} />}
          {thinNote && (
            <View style={styles.thin}>
              <Text style={styles.thinKicker}>THIN EVIDENCE</Text>
              <Text style={styles.thinText}>{thinNote}. Fewer than eight similar postings were found, so there is less to cross-check against.</Text>
            </View>
          )}
          <CoverageMeter meter={home.coverage} />
          <View style={styles.list}>
            <Text style={styles.listKicker}>IN LEARNING ORDER</Text>
            {home.concepts.map((c, i) => (
              <ConceptRow key={c.id} concept={c} index={i} count={home.concepts.length} open={open.has(c.id)} onToggle={() => toggle(c.id)} onOpenLink={(url) => void openLink(url)} />
            ))}
          </View>
        </ScrollView>
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { paddingHorizontal: detail.backSide, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 2 },
  mode: { fontFamily: font.mono.medium, fontSize: 12, color: colors.course.muted },
  modeTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8, fontFamily: font.sans.semibold, fontSize: 14.5, color: colors.text.primary },
  spacer: { width: 44 },
  compact: { marginHorizontal: 20, marginTop: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: colors.detail.summaryBorder },
  compactName: { flex: 1, fontFamily: font.sans.semibold, fontSize: 14, color: colors.text.primary },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 10, gap: 10 },
  head: { paddingHorizontal: 4, paddingBottom: 4, gap: 4 },
  title: { fontFamily: font.sans.semibold, fontSize: 26, lineHeight: 29, letterSpacing: -0.78, color: colors.text.primary },
  thin: { paddingHorizontal: 4, marginBottom: 14, gap: 4 },
  thinKicker: { fontFamily: font.mono.regular, fontSize: 11, letterSpacing: 1, color: colors.course.muted },
  thinText: { fontFamily: font.mono.regular, fontSize: 12, lineHeight: 17, color: colors.course.muted },
  sub: { fontFamily: font.mono.regular, fontSize: 12, color: colors.course.muted },
  list: { paddingTop: 8, gap: 8 },
  listKicker: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.muted, paddingHorizontal: 4, paddingBottom: 2 },
});
