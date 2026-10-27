import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { BackButton } from '../../components/BackButton';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ScreenBackground } from '../../components/ScreenBackground';
import { Toast } from '../../components/Toast';
import { useToast } from '../../components/useToast';
import type { SocialApi } from '../../data/socialApi';
import { colors, detail, profile as layout, typography } from '../../theme';
import { explain } from '../readers/explain';
import { avatarOf } from '../readers/readerView';
import { ReportSheet } from '../readers/ReportSheet';
import { sendMessage } from '../readers/sendMessage';
import { useReaderCard } from '../readers/useReaderCard';
import { useSocialApi } from '../readers/useSocialApi';
import { VisibilityPrompt } from '../readers/VisibilityPrompt';
import { InMailSheet } from './InMailSheet';
import { ProfileSummary } from './ProfileSummary';

/**
 * Another reader's profile, as they chose to show it: name, industry, interests and how many articles they verified. From here a
 * reader can send a message request (if they take messages), block them, or report them. A card that cannot be shown says only that
 * the reader was not found, whatever the reason.
 */
export function ReaderProfileScreen({ social: override, articleId }: { social?: SocialApi | null; articleId?: string }) {
  const params = useLocalSearchParams<{ id?: string | string[]; article?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const fromArticle = articleId ?? (Array.isArray(params.article) ? params.article[0] : params.article);
  const social = useSocialApi(override);
  const { status, card, reload } = useReaderCard(id, social);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [composing, setComposing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState<string | undefined>();
  const [reporting, setReporting] = useState(false);
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/feed'));

  const block = async () => {
    if (!social || !card) return;
    setBlockError(undefined);
    const res = await social.block(card.public_id);
    if (res.kind === 'ok') {
      setBlocking(false);
      toast.show(`${card.display_name} is blocked`);
      goBack();
    } else setBlockError(explain(res));
  };

  const body = () => {
    if (!social || status === 'notFound' || status === 'unavailable') {
      return (
        <View style={styles.center}>
          <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Reader not found</Text>
          <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
            {status === 'unavailable' ? "Couldn't load this profile right now." : 'This profile is not available.'}
          </Text>
        </View>
      );
    }
    if (status === 'loading') {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text.secondary} />
        </View>
      );
    }
    if (status === 'needsVisibility') {
      return (
        <View style={[styles.center, styles.prompt]}>
          <VisibilityPrompt social={social} message="You can see other readers' profiles when you are visible to them too." onTurnedOn={reload} />
        </View>
      );
    }
    if (!card) return null;
    const avatar = avatarOf(card.display_name, card.public_id);
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + detail.contentTop, paddingBottom: insets.bottom + layout.bottomClear }]} showsVerticalScrollIndicator={false}>
        <ProfileSummary name={card.display_name} industry={card.industry} interests={card.interests} tone={avatar.tone} avatarId={`reader-profile-avatar-${card.public_id}`} />
        <Text style={[typography.detailMeta, styles.centered, { color: colors.detail.meta }]}>
          {`${card.verified_count} verified ${card.verified_count === 1 ? 'article' : 'articles'}`}
        </Text>
        {card.can_message ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Send message request" onPress={() => setComposing(true)} style={styles.send}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.detail.openText} strokeWidth={2} strokeLinejoin="round">
              <Rect x="3" y="5" width="18" height="14" rx="3" />
              <Path d="m4 7 8 6 8-6" />
            </Svg>
            <Text style={[typography.stateButtonPrimary, { color: colors.detail.openText }]}>Send message request</Text>
          </Pressable>
        ) : (
          <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>{`${card.display_name.split(' ')[0]} isn't taking messages.`}</Text>
        )}
        <View style={styles.safety}>
          <Pressable accessibilityRole="button" accessibilityLabel="Block" onPress={() => { setBlockError(undefined); setBlocking(true); }} style={styles.secondary}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Block</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Report" onPress={() => setReporting(true)} style={styles.secondary}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Report</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  };

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton onPress={goBack} />
        </View>
        {body()}

        {social && card && status === 'ready' && (
          <>
            <InMailSheet
              visible={composing}
              mode="new"
              to={{ readerId: card.public_id, name: card.display_name, ...avatarOf(card.display_name, card.public_id) }}
              initialSubject=""
              onSend={(draft) => sendMessage(social, { to: card.public_id, subject: draft.subject, body: draft.body, articleId: fromArticle })}
              onClose={() => setComposing(false)}
              onSent={() => {
                setComposing(false);
                toast.show(`Request sent to ${card.display_name}`);
              }}
            />
            <ConfirmDialog
              visible={blocking}
              title={`Block ${card.display_name}?`}
              body="You will not see each other any more, and they won't be told. You can unblock them any time in Profile."
              confirmLabel="Block"
              destructive
              error={blockError}
              onConfirm={() => void block()}
              onCancel={() => setBlocking(false)}
            />
            <ReportSheet
              visible={reporting}
              title={`Report ${card.display_name}`}
              onClose={() => setReporting(false)}
              onSubmit={async (draft) => {
                const res = await social.report({ publicId: card.public_id, reason: draft.reason, note: draft.note, alsoBlock: draft.alsoBlock, articleId: fromArticle });
                if (res.kind !== 'ok') return explain(res);
                setReporting(false);
                toast.show('Thanks, we will review it');
                if (draft.alsoBlock) goBack();
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
  content: { paddingHorizontal: layout.sidePadding, gap: layout.sectionGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: layout.sidePadding },
  prompt: { alignItems: 'stretch' },
  centered: { textAlign: 'center' },
  send: { alignSelf: 'center', height: 44, paddingLeft: 16, paddingRight: 20, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.detail.openBg },
  safety: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 999, backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
