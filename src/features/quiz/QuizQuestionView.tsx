import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, detail, radius, typography } from '../../theme';
import type { QuizOption } from './useQuiz';

const LETTERS = ['A', 'B', 'C', 'D'];

/** One question: the prompt, four options, and right-or-wrong feedback once one is chosen. */
export function QuizQuestionView({
  number,
  prompt,
  options,
  picked,
  onChoose,
}: {
  number: number;
  prompt: string;
  options: QuizOption[];
  picked: number | null;
  onChoose: (position: number) => void;
}) {
  const answered = picked !== null;
  const right = answered && options[picked].correct;
  return (
    <View style={styles.root}>
      <Text style={[typography.sectionLabel, { color: colors.detail.summaryLabel }]}>{`QUESTION ${number}`}</Text>
      <Text style={[typography.cardTitle, { color: colors.text.primary }]}>{prompt}</Text>

      <View style={styles.options}>
        {options.map((option, position) => {
          const isPicked = picked === position;
          // After answering: the right option is green, a wrong pick is red, the rest fade.
          const state = !answered ? 'idle' : option.correct ? 'right' : isPicked ? 'wrong' : 'faded';
          const tone = TONES[state];
          return (
            <Pressable
              key={position}
              accessibilityRole="button"
              accessibilityLabel={option.text}
              accessibilityState={{ disabled: answered, selected: isPicked }}
              disabled={answered}
              onPress={() => onChoose(position)}
              style={[styles.option, { backgroundColor: tone.bg, borderColor: tone.border, opacity: state === 'faded' ? 0.5 : 1 }]}
            >
              <View style={[styles.letter, { borderColor: tone.border }]}>
                <Text style={[typography.cardTag, { color: tone.text }]}>{LETTERS[position]}</Text>
              </View>
              <Text style={[typography.peopleName, styles.optionText, { color: tone.text }]}>{option.text}</Text>
              {state === 'right' && <Mark color={colors.tag.Release.fg} path="M20 6 9 17l-5-5" />}
              {state === 'wrong' && <Mark color={colors.swipe.skip.labelText} path="M6 6l12 12M18 6 6 18" />}
            </Pressable>
          );
        })}
      </View>

      {answered && (
        <Text accessibilityLiveRegion="polite" style={[typography.stateBody, { color: right ? colors.tag.Release.fg : colors.swipe.skip.labelText }]}>
          {right ? 'Correct' : 'Not quite. The right answer is marked in green.'}
        </Text>
      )}
    </View>
  );
}

function Mark({ color, path }: { color: string; path: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <Path d={path} />
    </Svg>
  );
}

const TONES = {
  idle: { bg: colors.detail.peopleBg, border: colors.detail.peopleBorder, text: colors.text.primary },
  faded: { bg: colors.detail.peopleBg, border: colors.detail.peopleBorder, text: colors.text.primary },
  right: { bg: colors.tag.Release.bg, border: colors.tag.Release.fg, text: colors.tag.Release.fg },
  wrong: { bg: colors.button.skip.pressedBg, border: colors.swipe.skip.ring, text: colors.swipe.skip.labelText },
} as const;

const styles = StyleSheet.create({
  root: { gap: detail.contentGap - 4 },
  options: { gap: 10, marginTop: 4 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: detail.peopleGap,
    paddingVertical: detail.peopleRowPaddingV + 4,
    paddingHorizontal: detail.peopleRowPaddingH,
    borderRadius: detail.peopleRadius,
    borderWidth: 1.5,
  },
  optionText: { flex: 1 },
  letter: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
