import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { Quiz } from '../../data';
import { colors, detail, radius, typography } from '../../theme';
import { VerifiedBadge } from './VerifiedBadge';

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * A verified article's quiz as a quick revision sheet: every question with the right answer marked.
 * Nothing here can be tapped, and nothing is scored or saved.
 */
export function QuizRevisionView({ quiz }: { quiz: Quiz }) {
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <VerifiedBadge />
        <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>The right answers are marked in green.</Text>
      </View>

      {quiz.questions.map((question, q) => (
        <View key={q} style={styles.question}>
          <Text style={[typography.sectionLabel, { color: colors.detail.summaryLabel }]}>{`QUESTION ${q + 1}`}</Text>
          <Text style={[typography.cardTitle, { color: colors.text.primary }]}>{question.prompt}</Text>
          <View style={styles.options}>
            {question.options.map((option, i) => {
              const right = i === question.correct_index;
              const tone = right ? TONE.right : TONE.other;
              return (
                <View
                  key={i}
                  accessible
                  accessibilityLabel={right ? `${option}, correct answer` : option}
                  style={[styles.option, { backgroundColor: tone.bg, borderColor: tone.border }]}
                >
                  <View style={[styles.letter, { borderColor: tone.border }]}>
                    <Text style={[typography.cardTag, { color: tone.text }]}>{LETTERS[i]}</Text>
                  </View>
                  <Text style={[typography.peopleName, styles.optionText, { color: tone.text, opacity: right ? 1 : 0.7 }]}>{option}</Text>
                  {right && (
                    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.tag.Release.fg} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M20 6 9 17l-5-5" />
                    </Svg>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const TONE = {
  right: { bg: colors.tag.Release.bg, border: colors.tag.Release.fg, text: colors.tag.Release.fg },
  other: { bg: colors.detail.peopleBg, border: colors.detail.peopleBorder, text: colors.text.primary },
} as const;

const styles = StyleSheet.create({
  root: { gap: 28 },
  head: { gap: 12 },
  question: { gap: detail.contentGap - 8 },
  options: { gap: 10 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.peopleGap,
    paddingVertical: detail.peopleRowPaddingV + 2,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    borderWidth: 1.5,
  },
  optionText: { flex: 1 },
  letter: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
