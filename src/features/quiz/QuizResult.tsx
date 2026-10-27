import { StyleSheet, Text, View } from 'react-native';
import { colors, statePanel, typography } from '../../theme';
import { StateButton } from '../feed/FeedStatus';
import { VerifiedBadge } from './VerifiedBadge';

/** The end of a quiz: Verified when all answers were right, otherwise the score and a way to try again. */
export function QuizResult({
  score,
  total,
  passed,
  onTryAgain,
  onClose,
}: {
  score: number;
  total: number;
  passed: boolean;
  onTryAgain: () => void;
  onClose: () => void;
}) {
  if (passed) {
    return (
      <View style={styles.root}>
        <VerifiedBadge size="large" />
        <Text style={[typography.feedTitle, { color: colors.text.primary }]}>Verified</Text>
        <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
          {`You answered all ${total} questions correctly. This article now carries a Verified badge.`}
        </Text>
        <View style={styles.buttons}>
          <StateButton label="Done" onPress={onClose} primary />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <Text style={[typography.sectionLabel, { color: colors.detail.summaryLabel }]}>YOUR SCORE</Text>
      <Text accessibilityLabel={`${score} of ${total}`} style={[typography.feedTitle, { color: colors.text.primary }]}>{`${score} of ${total}`}</Text>
      <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
        {`Answer all ${total} correctly to earn the Verified badge.`}
      </Text>
      <View style={styles.buttons}>
        <StateButton label="Try again" onPress={onTryAgain} primary />
        <StateButton label="Close" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: statePanel.gap, padding: statePanel.padding },
  centered: { textAlign: 'center' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: statePanel.buttonGap, marginTop: statePanel.buttonsMarginTop },
});
