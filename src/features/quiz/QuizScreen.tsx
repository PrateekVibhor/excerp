import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { BottomActionBar } from '../../components/BottomActionBar';
import { ScreenBackground } from '../../components/ScreenBackground';
import { syncQueue, verifiedRepository, type Article, type Quiz, type SyncQueue, type VerifiedRepository } from '../../data';
import { colors, detail, statePanel, typography } from '../../theme';
import { useArticle } from '../article/useArticle';
import { StateButton } from '../feed/FeedStatus';
import { QuizQuestionView } from './QuizQuestionView';
import { QuizRevisionView } from './QuizRevisionView';
import { QuizResult } from './QuizResult';
import { useQuiz } from './useQuiz';
import { useVerifiedState } from './useVerified';

/** One run through the quiz. Nothing is saved until the last answer is in and every answer was right. */
function QuizRun({ article, quiz, verified, sync, onClose }: { article: Article; quiz: Quiz; verified: VerifiedRepository; sync: SyncQueue; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const run = useQuiz(quiz);
  const scroll = useRef<ScrollView>(null);
  // After an answer, show the end of the page: with large text the options and the feedback line can sit under the Next bar.
  useEffect(() => {
    if (run.phase === 'answered') scroll.current?.scrollToEnd?.({ animated: true });
  }, [run.phase]);

  // Saving happens once per pass, when the result appears. A second pass of the same article changes nothing.
  const saved = useRef(false);
  useEffect(() => {
    if (run.phase !== 'result' || !run.passed || saved.current) return;
    saved.current = true;
    // The badge comes first and never waits for the network: the record is saved on the device, and only then is the
    // verification queued for the leaderboard and a send tried. No network just leaves it waiting in the queue.
    void (async () => {
      try {
        const { record, added } = await verified.add(article.id, article.topic);
        if (!added) return; // already verified and already queued when it was first passed
        await sync.enqueue(article.id, record.verified_at);
        await sync.flush();
      } catch (error) {
        console.warn('Could not save the verified badge', error);
      }
    })();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [run.phase, run.passed, verified, sync, article.id, article.topic]);

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
        <BackButton label="Article" onPress={onClose} />
        {run.phase !== 'result' && (
          <Text accessibilityLabel={`Question ${run.number} of ${run.total}`} style={[typography.feedProgress, { color: colors.text.tertiary }]}>
            {`${run.number} / ${run.total}`}
          </Text>
        )}
      </View>

      {run.phase === 'result' ? (
        <QuizResult score={run.score} total={run.total} passed={run.passed} onTryAgain={run.restart} onClose={onClose} />
      ) : (
        <>
          <ScrollView
            ref={scroll}
            contentContainerStyle={[styles.content, { paddingTop: insets.top + detail.contentTop, paddingBottom: insets.bottom + detail.contentBottomClear }]}
            showsVerticalScrollIndicator={false}
          >
            <QuizQuestionView number={run.number} prompt={run.question.prompt} options={run.options} picked={run.picked} onChoose={run.choose} />
          </ScrollView>
          {run.phase === 'answered' && (
            <BottomActionBar
              id="quiz-bottom-fade"
              label={run.isLast ? 'See result' : 'Next'}
              hint={`${run.score} of ${run.answered} correct so far`}
              bottomInset={insets.bottom}
              onPress={run.next}
              icon={
                <Svg width={detail.openIcon} height={detail.openIcon} viewBox="0 0 24 24" fill="none" stroke={colors.detail.openText} strokeWidth={detail.openIconStroke} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M5 12h14M13 6l6 6-6 6" />
                </Svg>
              }
            />
          )}
        </>
      )}
    </View>
  );
}

/** A verified article's quiz, read-only: all the questions with the right answers marked. */
function RevisionRun({ quiz, onClose }: { quiz: Quiz; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
        <BackButton label="Article" onPress={onClose} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + detail.contentTop, paddingBottom: insets.bottom + detail.contentTop }]}
        showsVerticalScrollIndicator={false}
      >
        <QuizRevisionView quiz={quiz} />
      </ScrollView>
    </View>
  );
}

export function QuizScreen({ verified = verifiedRepository, sync = syncQueue }: { verified?: VerifiedRepository; sync?: SyncQueue }) {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, article, retry } = useArticle(id);
  const stored = useVerifiedState(id, verified);
  // Whether the article was already verified when this screen opened, decided once. Passing the quiz now makes
  // it verified, but the result screen must stay up, so later changes are ignored.
  const [wasVerified, setWasVerified] = useState<boolean | null>(null);
  useEffect(() => {
    if (stored.ready) setWasVerified((previous) => previous ?? stored.verified);
  }, [stored.ready, stored.verified]);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/feed'));

  // Without a quiz there is nothing to run: the same panel as a missing article.
  const quiz = article?.quiz ?? null;
  const problem =
    status === 'ready' && !quiz ? { title: 'No quiz for this article', body: 'Go back and pick another one.' }
    : status === 'notFound' ? { title: 'Article not found', body: 'It may have been removed.' }
    : status === 'error' ? { title: "Couldn't load this quiz", body: 'Check your connection and try again.' }
    : null;

  return (
    <ScreenBackground>
      {status === 'ready' && article && quiz && wasVerified === true ? (
        <RevisionRun quiz={quiz} onClose={close} />
      ) : status === 'ready' && article && quiz && wasVerified === false ? (
        <QuizRun article={article} quiz={quiz} verified={verified} sync={sync} onClose={close} />
      ) : (
        <View style={styles.root}>
          <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
            <BackButton label="Article" onPress={close} />
          </View>
          <View style={styles.center}>
            {(status === 'loading' || (status === 'ready' && quiz && wasVerified === null)) && <ActivityIndicator color={colors.text.secondary} />}
            {problem && (
              <>
                <Text style={[typography.stateTitle, { color: colors.text.primary }]}>{problem.title}</Text>
                <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>{problem.body}</Text>
                {status === 'error' && (
                  <View style={styles.retry}>
                    <StateButton label="Retry" onPress={retry} primary />
                  </View>
                )}
              </>
            )}
          </View>
        </View>
      )}
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
  content: { paddingHorizontal: detail.contentSide, gap: detail.contentGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap, padding: statePanel.padding },
  centered: { textAlign: 'center' },
  retry: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
