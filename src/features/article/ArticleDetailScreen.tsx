import { BlurView } from 'expo-blur';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { BottomActionBar } from '../../components/BottomActionBar';
import { GlassCard } from '../../components/GlassCard';
import { ScreenBackground } from '../../components/ScreenBackground';
import { TopFade } from '../../components/TopFade';
import type { Article } from '../../data';
import { blur, colors, detail, radius, statePanel, typography } from '../../theme';
import { brandFor, formatPublishedDate, tagFor, monogramFor, sourceDomain } from '../feed/cardFormat';
import { StateButton } from '../feed/FeedStatus';
import { ReviewAnswersButton } from '../quiz/ReviewAnswersButton';
import { TakeQuizButton } from '../quiz/TakeQuizButton';
import { VerifiedBadge } from '../quiz/VerifiedBadge';
import { useVerified } from '../quiz/useVerified';
import { AlsoReadingRow } from './AlsoReadingRow';
import { openOriginal } from './openOriginal';
import { useArticle } from './useArticle';
import { useSavedState } from './useSavedState';

const backLabels: Record<string, string> = { feed: 'Discover', 'reading-list': 'Reading List' };

function SummaryPanel({ summary }: { summary: string }) {
  return (
    <GlassCard id="summary-sheen">
      <Text style={[typography.sectionLabel, { color: colors.detail.summaryLabel }]}>SUMMARY</Text>
      <Text style={[typography.detailSummary, { color: colors.detail.summaryText }]}>{summary}</Text>
    </GlassCard>
  );
}

/** "Saved" when the article is in the Reading List; otherwise a Save button that adds it. */
function SaveControl({ saved, onSave }: { saved: boolean; onSave: () => void }) {
  const label = saved ? 'Saved' : 'Save';
  return (
    <Pressable
      accessibilityRole={saved ? 'text' : 'button'}
      accessibilityLabel={label}
      accessibilityState={{ selected: saved }}
      disabled={saved}
      onPress={saved ? undefined : onSave}
      style={styles.save}
    >
      <BlurView intensity={blur.card} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <Svg
        width={detail.saveIcon}
        height={detail.saveIcon}
        viewBox="0 0 24 24"
        fill={saved ? colors.detail.savedIcon : 'none'}
        stroke={saved ? colors.detail.savedIcon : colors.detail.saveText}
        strokeWidth={detail.saveIconStroke}
        strokeLinejoin="round"
      >
        <Path d="M6 3h12v18l-6-4-6 4z" />
      </Svg>
      <Text style={[typography.saveLabel, { color: saved ? colors.detail.savedIcon : colors.detail.saveText }]}>{label}</Text>
    </Pressable>
  );
}

/** Fixed bar with the Open original button, fading in from the page behind it. */
function BottomBar({ domain, bottomInset, onOpen }: { domain: string; bottomInset: number; onOpen: () => void }) {
  return (
    <BottomActionBar
      id="bottom-fade"
      label="Open original"
      hint={`Opens on ${domain}`}
      bottomInset={bottomInset}
      onPress={onOpen}
      icon={
        <Svg width={detail.openIcon} height={detail.openIcon} viewBox="0 0 24 24" fill="none" stroke={colors.detail.openText} strokeWidth={detail.openIconStroke} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M7 17 17 7M8 7h9v9" />
        </Svg>
      }
    />
  );
}

function ArticleBody({ article, verified, onOpenReader, onTakeQuiz }: { article: Article; verified: boolean; onOpenReader: (id: string) => void; onTakeQuiz: () => void }) {
  const brand = brandFor(article.source_company);
  const tag = tagFor(article.content_type);
  return (
    <>
      <View style={styles.header}>
        <View style={[styles.monogram, { backgroundColor: brand.bg }]}>
          <Text style={[typography.detailMonogram, { color: brand.fg }]}>{monogramFor(article.source_company)}</Text>
        </View>
        <View style={styles.company}>
          <Text style={[typography.detailCompany, { color: colors.text.primary }]} numberOfLines={1}>
            {article.source_company}
          </Text>
          <Text style={[typography.detailDomain, { color: colors.text.tertiary }]}>{sourceDomain(article.source_url)}</Text>
        </View>
        <View style={[styles.tag, { backgroundColor: tag.bg }]}>
          <Text style={[typography.cardTag, { color: tag.fg }]}>{article.content_type}</Text>
        </View>
      </View>

      <Text style={[typography.detailTitle, { color: colors.text.primary }]}>{article.title}</Text>

      <View style={styles.meta}>
        <Text style={[typography.detailMeta, { color: colors.detail.meta }]}>{formatPublishedDate(article.published_at)}</Text>
        {article.reader_count > 0 && <Text style={[typography.detailMeta, { color: colors.detail.meta }]}>{`${article.reader_count} reading`}</Text>}
      </View>

      <SummaryPanel summary={article.summary} />
      {/* A quiz is offered only when the article has one; once passed, the badge takes the button's place. */}
      {verified ? (article.quiz ? <ReviewAnswersButton onPress={onTakeQuiz} /> : <VerifiedBadge />) : article.quiz ? <TakeQuizButton questions={article.quiz.questions.length} onPress={onTakeQuiz} /> : null}
      <AlsoReadingRow articleId={article.id} onOpenReader={onOpenReader} />
    </>
  );
}

export function ArticleDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; from?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const from = Array.isArray(params.from) ? params.from[0] : params.from;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, article, retry } = useArticle(id);
  const { saved, save } = useSavedState(article?.id);
  const verified = useVerified(article?.id);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/feed'));
  const openReader = (readerId: string) => router.push(article ? `/reader/${readerId}?article=${article.id}` : `/reader/${readerId}`);
  const takeQuiz = () => article && router.push(`/quiz/${article.id}`);
  const domain = article ? sourceDomain(article.source_url) : '';

  // Taps while the browser is still open or opening are ignored.
  const opening = useRef(false);
  const openSource = async () => {
    if (!article || opening.current) return;
    opening.current = true;
    try {
      await openOriginal(article.source_url);
    } finally {
      opening.current = false;
    }
  };

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <TopFade id="top-fade" height={insets.top + detail.backTop + detail.backHeight + detail.topFadeExtra} scrollY={scrollY} />
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton label={(from && backLabels[from]) || 'Back'} onPress={goBack} />
          {status === 'ready' && <SaveControl saved={saved} onSave={save} />}
        </View>

        {status === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text.secondary} />
          </View>
        )}

        {status === 'notFound' && (
          <View style={styles.center}>
            <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Article not found</Text>
            <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
              It may have been removed.
            </Text>
          </View>
        )}

        {status === 'error' && (
          <View style={styles.center}>
            <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Couldn't load this article</Text>
            <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
              Check your connection and try again.
            </Text>
            <View style={styles.retry}>
              <StateButton label="Retry" onPress={retry} primary />
            </View>
          </View>
        )}

        {status === 'ready' && article && (
          <>
            <Animated.ScrollView
              onScroll={onScroll}
              scrollEventThrottle={16}
              contentContainerStyle={[
                styles.content,
                { paddingTop: insets.top + detail.contentTop, paddingBottom: insets.bottom + detail.contentBottomClear },
              ]}
              showsVerticalScrollIndicator={false}
            >
              <ArticleBody article={article} verified={verified} onOpenReader={openReader} onTakeQuiz={takeQuiz} />
            </Animated.ScrollView>

            <BottomBar domain={domain} bottomInset={insets.bottom} onOpen={openSource} />
          </>
        )}
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    position: 'absolute',
    left: detail.backSide,
    right: detail.backSide,
    zIndex: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  save: {
    height: detail.backHeight,
    paddingLeft: detail.savePaddingLeft,
    paddingRight: detail.savePaddingRight,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.backGap,
    backgroundColor: colors.detail.saveBg,
    borderWidth: 1,
    borderColor: colors.detail.saveBorder,
    overflow: 'hidden',
  },
  content: { paddingHorizontal: detail.contentSide, gap: detail.contentGap },
  header: { flexDirection: 'row', alignItems: 'center', gap: detail.headerGap },
  monogram: {
    width: detail.monogram,
    height: detail.monogram,
    borderRadius: detail.monogramRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  company: { flex: 1, gap: 4 },
  tag: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: radius.pill },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: detail.metaGapColumn, rowGap: detail.metaGapRow },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap, padding: statePanel.padding },
  centered: { textAlign: 'center' },
  retry: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
