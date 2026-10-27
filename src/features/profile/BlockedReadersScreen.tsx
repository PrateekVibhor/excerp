import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { ScreenBackground } from '../../components/ScreenBackground';
import type { BlockEntry, SocialApi } from '../../data/socialApi';
import { colors, detail, inbox, typography } from '../../theme';
import { explain } from '../readers/explain';
import { useSocialApi } from '../readers/useSocialApi';

/** The readers this reader has blocked, each with a button to unblock. Nobody else can see this list. */
export function BlockedReadersScreen({ social: override }: { social?: SocialApi | null }) {
  const social = useSocialApi(override);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  const load = useCallback(async () => {
    if (!social) return setStatus('unavailable');
    const res = await social.blocks();
    if (res.kind === 'ok') {
      setBlocks(res.value);
      setStatus('ready');
    } else setStatus('unavailable');
  }, [social]);
  useEffect(() => {
    void load();
  }, [load]);

  const unblock = async (b: BlockEntry) => {
    if (!social) return;
    setError(undefined);
    const res = await social.unblock(b.public_id);
    if (res.kind === 'ok') setBlocks((list) => list.filter((x) => x.public_id !== b.public_id));
    else setError(explain(res));
  };

  return (
    <ScreenBackground>
      <View style={styles.root}>
        <View style={[styles.topBar, { top: insets.top + detail.backTop }]}>
          <BackButton label="Profile" onPress={goBack} />
        </View>
        <View style={[styles.header, { paddingTop: insets.top + detail.backTop + detail.backHeight + inbox.headerTop }]}>
          <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Blocked readers</Text>
        </View>
        {status === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text.secondary} />
          </View>
        ) : (
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + inbox.bottomClear }]} showsVerticalScrollIndicator={false}>
            {status === 'unavailable' && <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Couldn't load your blocked readers right now.</Text>}
            {status === 'ready' && blocks.length === 0 && <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>You haven't blocked anyone.</Text>}
            {error ? <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>{error}</Text> : null}
            {blocks.map((b) => (
              <View key={b.public_id} style={styles.row}>
                <Text style={[typography.peopleName, styles.name, { color: colors.text.primary }]}>{b.display_name}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Unblock ${b.display_name}`} onPress={() => void unblock(b)} style={styles.button}>
                  <Text style={[typography.pillButton, { color: colors.text.primary }]}>Unblock</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', left: detail.backSide, right: detail.backSide, zIndex: 2, flexDirection: 'row' },
  header: { paddingHorizontal: 24 },
  scroll: { flex: 1, marginTop: inbox.listTop },
  content: { paddingHorizontal: inbox.sidePadding, gap: inbox.rowGap },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: detail.peopleRowPaddingH, borderRadius: detail.peopleRadius, backgroundColor: colors.detail.peopleBg, borderWidth: 1, borderColor: colors.detail.peopleBorder },
  name: { flex: 1 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 999, backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
});
