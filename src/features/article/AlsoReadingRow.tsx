import { StyleSheet, Text, View } from 'react-native';
import { ReaderList } from '../../components/ReaderList';
import type { SocialApi } from '../../data/socialApi';
import { colors, detail, typography } from '../../theme';
import { toListReader } from '../readers/readerView';
import { useReaders } from '../readers/useReaders';
import { useSocialApi } from '../readers/useSocialApi';
import { VisibilityPrompt } from '../readers/VisibilityPrompt';
import type { openOriginal } from './openOriginal';

/**
 * "Also reading this": the readers who chose to be seen and saved or verified this article lately. A reader who has not turned on being
 * seen themselves is invited to; with nobody to show, or no server (mock data), or a failure, there is nothing here at all.
 * Each reader opens that reader's profile.
 */
export function AlsoReadingRow({
  articleId,
  onOpenReader,
  social: override,
  browser,
}: {
  articleId: string;
  onOpenReader: (publicId: string) => void;
  social?: SocialApi | null;
  browser?: Parameters<typeof openOriginal>[1];
}) {
  const social = useSocialApi(override);
  const { status, readers, reload } = useReaders(articleId, social);
  if (!social) return null;

  if (status === 'needsVisibility') {
    return (
      <View style={styles.section}>
        <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>ALSO READING THIS</Text>
        <VisibilityPrompt social={social} browser={browser} message="Other readers can see who else is reading this when they are visible too. Turn on being seen to find out." onTurnedOn={reload} />
      </View>
    );
  }
  if (status !== 'ready' || readers.length === 0) return null;

  const rows = readers.map((r) => ({ ...toListReader(r), detail: `${r.industry} · ${r.action === 'verified' ? 'Verified it' : 'Saved it'}` }));
  return (
    <View style={styles.section}>
      <Text style={[typography.sectionLabel, { color: colors.detail.sectionLabel }]}>ALSO READING THIS</Text>
      <ReaderList readers={rows} idPrefix={`reader-avatar-${articleId}`} onOpenReader={onOpenReader} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: detail.sectionGap },
});
