import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScroll } from '../../components/KeyboardSafe';
import { useBottomClear } from '../../components/useBottomClear';
import type { Profile } from '../../data';
import { colors, detail, feed, profile as layout, statePanel, typography } from '../../theme';
import { EnvelopeButton } from '../inbox/EnvelopeButton';
import { StateButton } from '../feed/FeedStatus';
import { AccountRow } from '../auth/AccountRow';
import { AccountReference } from '../auth/AccountReference';
import { DeleteAccountRow } from '../auth/DeleteAccountRow';
import { LeaderboardLink } from '../leaderboard/LeaderboardLink';
import { MessagingSettingsCard } from '../readers/MessagingSettingsCard';
import { ProfileForm } from './ProfileForm';
import { PrivacyLink } from './PrivacyLink';
import { TermsLink } from './TermsLink';
import { WithdrawConsentRow } from './WithdrawConsentRow';
import { ProfileSummary } from './ProfileSummary';
import type { SocialApi } from '../../data/socialApi';
import { useProfile, type ProfileSource } from './useProfile';
import { useVerifiedStats } from './useVerifiedStats';
import { VerifiedStats } from './VerifiedStats';

function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.pill}>
      <Text style={[typography.pillButton, { color: colors.text.primary }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The Profile tab: the form until a profile is saved, then the saved profile with an
 * Edit profile button. The inbox's envelope button sits left of it in the header.
 */
export function ProfileScreen({ source, social }: { source?: ProfileSource; /** A stand-in for the server's social routes, for tests. */ social?: SocialApi | null }) {
  const insets = useSafeAreaInsets();
  const bottomClear = useBottomClear();
  const router = useRouter();
  const { status, profile, save, retry } = useProfile(source);
  const verified = useVerifiedStats();
  const [editing, setEditing] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const onSave = async (next: Profile) => {
    const saved = await save(next);
    setSaveFailed(!saved);
    if (saved) setEditing(false);
  };
  const showForm = status === 'ready' && (profile === null || editing);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text style={[typography.feedKicker, { color: colors.text.tertiary }]}>ON THIS DEVICE</Text>
          <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Your profile</Text>
        </View>
        <View style={styles.headerRight}>
          <EnvelopeButton />
          {status === 'ready' && profile !== null && !editing && (
            <PillButton label="Edit profile" onPress={() => setEditing(true)} />
          )}
          {status === 'ready' && profile !== null && editing && (
            <PillButton
              label="Cancel"
              onPress={() => {
                setEditing(false);
                setSaveFailed(false);
              }}
            />
          )}
        </View>
      </View>

      {status === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text.secondary} />
        </View>
      )}

      {status === 'error' && (
        <View style={styles.center}>
          <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Couldn't load your profile</Text>
          <View style={styles.retry}>
            <StateButton label="Retry" onPress={retry} primary />
          </View>
        </View>
      )}

      {status === 'ready' && (
        // The keyboard never covers the field being typed in: the form scrolls it into view, a drag dismisses the keyboard, and a tap on a button works the first time.
        <KeyboardSafeScroll
          scrollStyle={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: bottomClear }]}
          showsVerticalScrollIndicator={false}
        >
          {showForm ? (
            <>
              {saveFailed && (
                <Text accessibilityRole="alert" style={[typography.formHint, styles.failed, { color: colors.form.error }]}>
                  Couldn't save your profile. Try again.
                </Text>
              )}
              <ProfileForm initial={profile ?? undefined} onSave={onSave} />
            </>
          ) : (
            profile !== null && (
              <ProfileSummary
                name={profile.display_name}
                industry={profile.industry}
                interests={profile.interests}
                tone={0}
                avatarId="own-profile-avatar"
              />
            )
          )}
          <View style={styles.link}>
            <VerifiedStats stats={verified} />
          </View>
          <View style={styles.link}>
            <LeaderboardLink onPress={() => router.push('/leaderboard')} />
          </View>
          <View style={styles.readers}>
            <MessagingSettingsCard social={social} />
          </View>
          <View style={styles.account}>
            <AccountRow />
          </View>
          <View style={styles.account}>
            <AccountReference />
          </View>
          <View style={styles.account}>
            <DeleteAccountRow />
          </View>
          <WithdrawConsentRow style={styles.account} />
          <View style={styles.legal}>
            <TermsLink />
            <PrivacyLink />
          </View>
        </KeyboardSafeScroll>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: feed.headerPaddingTop,
    paddingHorizontal: feed.sidePadding + 4,
  },
  titles: { flex: 1, gap: feed.headerGap },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 },
  pill: {
    height: layout.pillHeight,
    paddingHorizontal: layout.pillPaddingH,
    borderRadius: 999,
    justifyContent: 'center',
    backgroundColor: colors.detail.backBg,
    borderWidth: 1,
    borderColor: colors.detail.backBorder,
  },
  scroll: { flex: 1, marginTop: feed.cardAreaTopGap },
  content: { paddingHorizontal: layout.sidePadding, paddingTop: 8 },
  failed: { marginBottom: 12 },
  link: { marginTop: layout.sectionGap },
  account: { marginTop: layout.sectionGap },
  legal: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 },
  readers: { marginTop: layout.sectionGap, gap: detail.sectionGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap },
  retry: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
