import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { BottomActionBar } from '../../components/BottomActionBar';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GlassCard } from '../../components/GlassCard';
import { ScreenBackground } from '../../components/ScreenBackground';
import { Toast } from '../../components/Toast';
import { TopFade } from '../../components/TopFade';
import { useToast } from '../../components/useToast';
import { inboxStore as defaultStore } from '../../data';
import type { InboxStore } from '../../data/inboxStore';
import { replySubject } from '../../data/messageDraft';
import type { MessageView, SocialApi, Thread } from '../../data/socialApi';
import { colors, detail, message, statePanel, typography } from '../../theme';
import { InMailSheet } from '../profile/InMailSheet';
import { explain } from '../readers/explain';
import { ReportSheet } from '../readers/ReportSheet';
import { sendMessage } from '../readers/sendMessage';
import { useSocialApi } from '../readers/useSocialApi';
import { otherOf, subjectOf } from './inboxText';
import { SenderCard } from './SenderCard';
import { receivedLabel } from './timeLabel';

const paragraphsOf = (body: string) => body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');

type Status = 'loading' | 'ready' | 'notFound' | 'unavailable';

/**
 * One conversation. A request waiting for an answer shows the message with Accept and Decline (a decline is silent); an open
 * conversation shows the messages with Reply; a request this reader sent shows it with a note that it is waiting. Each message can be
 * hidden from this reader's own view, and messages from the other person can be reported. Opening it marks what was received as read.
 */
export function ConversationScreen({ social: override, store = defaultStore, now = new Date() }: { social?: SocialApi | null; store?: InboxStore | null; /** The clock used for time labels. */ now?: Date }) {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const social = useSocialApi(override);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('loading');
  const [thread, setThread] = useState<Thread | null>(null);
  const [replying, setReplying] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reporting, setReporting] = useState<MessageView | null>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const [barHeight, setBarHeight] = useState(0);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/inbox'));

  const load = useCallback(async () => {
    if (!social || !id) return setStatus('notFound');
    const res = await social.thread(id);
    if (res.kind === 'ok') {
      setThread(res.value);
      setStatus('ready');
      // What was received is now read. Failing to remember that must not stop the messages being shown.
      const unread = res.value.messages.filter((m) => m.from === 'them' && !m.read);
      if (unread.length > 0) {
        await Promise.all(unread.map((m) => social.markRead(m.id)));
        void store?.refresh();
      }
    } else if (res.kind === 'refused' && res.status === 404) setStatus('notFound');
    else setStatus('unavailable');
  }, [social, id, store]);
  useEffect(() => {
    void load();
  }, [load]);

  const after = () => void store?.refresh();
  const accept = async () => {
    if (!social || !id) return;
    setProblem(undefined);
    const res = await social.accept(id);
    if (res.kind === 'ok') {
      toast.show('Request accepted');
      after();
      await load();
    } else setProblem(explain(res));
  };
  const decline = async () => {
    if (!social || !id) return;
    const res = await social.decline(id);
    if (res.kind === 'ok') {
      setDeclining(false);
      after();
      goBack();
    } else {
      setDeclining(false);
      setProblem(explain(res));
    }
  };
  const hide = async (m: MessageView) => {
    if (!social) return;
    setProblem(undefined);
    const res = await social.hide(m.id);
    if (res.kind !== 'ok') return setProblem(explain(res));
    after();
    await load();
  };
  const block = async () => {
    const publicId = thread?.other.public_id;
    if (!social || !publicId) return;
    const res = await social.block(publicId);
    setBlocking(false);
    if (res.kind === 'ok') {
      after();
      goBack();
    } else setProblem(explain(res));
  };

  const other = thread ? otherOf(thread) : null;
  const canReply = thread?.state === 'open' && thread.other.deleted === false;
  const firstName = other?.name.split(' ')[0] ?? 'This reader';
  // Room under the last message: the Reply bar's measured height (it grows with the text size) and a gap, never less than the fixed room the screen always had.
  const bottomClear = Math.max(insets.bottom + detail.contentBottomClear, canReply && barHeight > 0 ? barHeight + message.gap : 0);

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <TopFade id="message-top-fade" height={insets.top + detail.backTop + detail.backHeight + detail.topFadeExtra} scrollY={scrollY} />
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton label="Inbox" onPress={goBack} />
        </View>

        {status === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text.secondary} />
          </View>
        )}
        {(status === 'notFound' || status === 'unavailable') && (
          <View style={styles.center}>
            <Text style={[typography.stateTitle, { color: colors.text.primary }]}>{status === 'notFound' ? 'Conversation not found' : "Couldn't open it"}</Text>
            <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>{status === 'notFound' ? 'It may have been removed.' : 'Check your connection and try again.'}</Text>
          </View>
        )}

        {status === 'ready' && thread && other && social && (
          <>
            <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={[styles.content, { paddingTop: insets.top + detail.backTop + detail.backHeight + message.top, paddingBottom: bottomClear }]} showsVerticalScrollIndicator={false}>
              <SenderCard sender={other} avatarId={`message-avatar-${thread.id}`} onOpen={() => other.publicId && router.push(`/reader/${other.publicId}`)} />

              {thread.other.deleted && (
                <View style={styles.note}>
                  <Text style={[typography.stateBody, { color: colors.list.emptyBody }]}>This account was deleted. You can read what is here, but you can't reply.</Text>
                </View>
              )}

              {thread.messages.map((m, i) => (
                <View key={m.id} style={styles.message}>
                  <View style={styles.heading}>
                    {m.subject.trim() !== '' && <Text style={[typography.messageSubject, { color: colors.text.primary }]}>{subjectOf(m.subject)}</Text>}
                    <Text style={[typography.detailMeta, { color: colors.detail.sectionLabel }]}>{`${m.from === 'me' ? 'You' : firstName} · ${receivedLabel(m.created_at, now)}`}</Text>
                  </View>
                  <GlassCard id={`message-sheen-${i}`}>
                    {paragraphsOf(m.body).map((p, j) => (
                      <Text key={j} style={[typography.messageBody, { color: colors.detail.summaryText }]}>{p}</Text>
                    ))}
                  </GlassCard>
                  <View style={styles.links}>
                    {m.from === 'them' && (
                      <Pressable accessibilityRole="button" accessibilityLabel="Report this message" hitSlop={10} onPress={() => setReporting(m)}>
                        <Text style={[typography.formHint, styles.link, { color: colors.text.tertiary }]}>Report</Text>
                      </Pressable>
                    )}
                    <Pressable accessibilityRole="button" accessibilityLabel="Hide this message" hitSlop={10} onPress={() => void hide(m)}>
                      <Text style={[typography.formHint, styles.link, { color: colors.text.tertiary }]}>Hide</Text>
                    </Pressable>
                  </View>
                </View>
              ))}

              {thread.role === 'recipient' && thread.state === 'request' && (
                <View style={styles.actions}>
                  <Text style={[typography.stateBody, { color: colors.list.emptyBody }]}>{`${firstName} would like to talk. Accept to start a conversation. If you decline, they won't be told.`}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="Accept" onPress={() => void accept()} style={[styles.button, styles.primary]}>
                    <Text style={[typography.stateButtonPrimary, { color: colors.detail.openText }]}>Accept</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Decline" onPress={() => setDeclining(true)} style={styles.button}>
                    <Text style={[typography.pillButton, { color: colors.text.primary }]}>Decline</Text>
                  </Pressable>
                  {other.publicId !== null && (
                    <Pressable accessibilityRole="button" accessibilityLabel="Block" onPress={() => setBlocking(true)} style={styles.button}>
                      <Text style={[typography.pillButton, { color: colors.text.primary }]}>Block</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {thread.role === 'initiator' && (thread.state === 'pending' || thread.state === 'expired') && (
                <View style={styles.note}>
                  <Text style={[typography.stateBody, { color: colors.list.emptyBody }]}>
                    {thread.state === 'expired' ? 'This request has expired.' : `Waiting for a reply. If ${firstName} accepts, you can continue here.`}
                  </Text>
                </View>
              )}

              {problem ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{problem}</Text> : null}
            </Animated.ScrollView>

            {canReply && (
              <BottomActionBar
                id="message-bottom-fade"
                label="Reply"
                hint="Text only, no links"
                bottomInset={insets.bottom}
                onHeight={setBarHeight}
                onPress={() => setReplying(true)}
                icon={
                  <Svg width={message.replyIcon} height={message.replyIcon} viewBox="0 0 24 24" fill="none" stroke={colors.detail.openText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M9 14 4 9l5-5" />
                    <Path d="M4 9h10a6 6 0 0 1 6 6v4" />
                  </Svg>
                }
              />
            )}

            <InMailSheet
              visible={replying}
              mode="reply"
              to={{ readerId: thread.other.public_id ?? thread.id, name: other.name, initials: other.initials, tone: other.tone }}
              initialSubject={replySubject(thread.messages[thread.messages.length - 1]?.subject ?? '')}
              onSend={(draft) => sendMessage(social, { conversationId: thread.id, subject: draft.subject, body: draft.body })}
              onClose={() => setReplying(false)}
              onSent={() => {
                setReplying(false);
                toast.show(`Sent to ${other.name}`);
                after();
                void load();
              }}
            />
            <ConfirmDialog visible={declining} title="Decline this request?" body={`${firstName} won't be told. You won't be able to change your mind.`} confirmLabel="Decline" destructive onConfirm={() => void decline()} onCancel={() => setDeclining(false)} />
            <ConfirmDialog visible={blocking} title={`Block ${other.name}?`} body="You will not see each other any more, and they won't be told. You can unblock them any time in Profile." confirmLabel="Block" destructive onConfirm={() => void block()} onCancel={() => setBlocking(false)} />
            <ReportSheet
              visible={reporting !== null}
              title="Report this message"
              onClose={() => setReporting(null)}
              onSubmit={async (draft) => {
                if (!reporting) return undefined;
                const res = await social.report({ messageId: reporting.id, reason: draft.reason, note: draft.note, alsoBlock: draft.alsoBlock });
                if (res.kind !== 'ok') return explain(res);
                setReporting(null);
                toast.show('Thanks, we will review it');
                after();
                if (draft.alsoBlock) goBack();
                else await load();
                return undefined;
              }}
            />
          </>
        )}

        <Toast message={toast.message} />
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', left: detail.backSide, right: detail.backSide, zIndex: 2, flexDirection: 'row' },
  content: { paddingHorizontal: detail.contentSide, gap: message.gap },
  message: { gap: 8 },
  heading: { gap: message.subjectGap, marginTop: message.subjectTop },
  links: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20 },
  link: { textDecorationLine: 'underline', minHeight: 28, textAlignVertical: 'center' },
  actions: { gap: 10, marginTop: 8 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  primary: { backgroundColor: colors.detail.openBg, borderWidth: 0 },
  note: { paddingVertical: message.notePaddingV, paddingHorizontal: message.notePaddingH, borderRadius: message.noteRadius, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.statePanel.border },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap, padding: statePanel.padding },
  centered: { textAlign: 'center' },
});
