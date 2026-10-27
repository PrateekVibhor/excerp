import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import type { Article, LeaderboardApi, PostResult, QuizQuestion, SyncQueue } from '../../data';
import { createSyncQueue } from '../../data/syncQueue';
import { createMockRepositories } from '../../data/mockRepository';
import { createVerifiedRepository } from '../../data/verifiedRepository';
import { QuizScreen } from './QuizScreen';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success' },
  ImpactFeedbackStyle: { Light: 'light' },
}));
const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
let mockParams: { id?: string } = {};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));

const metrics = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
// The first mock article, which carries a quiz (the app code reaches mock data only through the repository).
let ARTICLE: Article;
let QUESTIONS: QuizQuestion[];
beforeAll(async () => {
  ARTICLE = (await createMockRepositories().articles.getById('mock-1'))!;
  QUESTIONS = ARTICLE.quiz!.questions;
});
const rightText = (q: number) => QUESTIONS[q].options[QUESTIONS[q].correct_index];
const wrongText = (q: number) => QUESTIONS[q].options.find((_, i) => i !== QUESTIONS[q].correct_index)!;

const opened: Array<ReturnType<typeof create>> = [];
const verified = () => createVerifiedRepository(AsyncStorage);
const stored = async () => JSON.parse((await AsyncStorage.getItem('swipy:verified')) ?? '[]');

async function open(id = 'mock-1', sync?: SyncQueue) {
  mockParams = { id };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <QuizScreen verified={verified()} sync={sync} />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  opened.push(renderer);
  const screen = {
    renderer,
    texts: () => [...new Set(renderer.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')))],
    has: (text: string) => screen.texts().includes(text),
    labels: () => [...new Set(renderer.root.findAll((n: ReactTestInstance) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel).map((n) => n.props.accessibilityLabel as string))],
    // The options on screen, top to bottom.
    optionOrder: () => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'button' && n.props.accessibilityState && 'selected' in n.props.accessibilityState && typeof n.props.onPress === 'function').map((n) => n.props.accessibilityLabel as string),
    press: async (label: string) => {
      const target = renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
      if (!target) throw new Error(`Nothing to press labelled "${label}". Pressable: ${screen.labels().join(' | ')}`);
      await act(async () => {
        target.props.onPress();
      });
    },
    pressText: async (text: string) => {
      const target = renderer.root.findAll((n: ReactTestInstance) => typeof n.props.onPress === 'function' && n.findAllByType(Text).some((t) => [t.props.children].flat().join('') === text))[0];
      if (!target) throw new Error(`No button showing "${text}"`);
      await act(async () => {
        target.props.onPress();
      });
    },
    // Answers question q (0-based) and moves on: Next, or See result after the last.
    answer: async (q: number, how: 'right' | 'wrong') => {
      await screen.press(how === 'right' ? rightText(q) : wrongText(q));
      await screen.press(q === 2 ? 'See result' : 'Next');
    },
  };
  return screen;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockRouter.canGoBack.mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => {
    opened.splice(0).forEach((r) => r.unmount());
  });
});

describe('QuizScreen: a question before answering', () => {
  it('shows progress "1 / 3", the question and its four options, and no Next yet', async () => {
    const screen = await open();
    expect(screen.has('1 / 3')).toBe(true);
    expect(screen.has('QUESTION 1')).toBe(true);
    expect(screen.has(QUESTIONS[0].prompt)).toBe(true);
    expect([...screen.optionOrder()].sort()).toEqual([...QUESTIONS[0].options].sort());
    expect(screen.optionOrder()).toHaveLength(4);
    expect(screen.labels()).not.toContain('Next');
    expect(screen.labels()).toContain('Back'); // the "Article" pill
    expect(screen.has('Correct')).toBe(false);
  });
});

describe('QuizScreen: feedback', () => {
  it('a right answer shows "Correct" at once, and a Next button', async () => {
    const screen = await open();
    await screen.press(rightText(0));
    expect(screen.has('Correct')).toBe(true);
    expect(screen.labels()).toContain('Next');
    expect(screen.has('1 of 1 correct so far')).toBe(true);
  });

  it('a wrong answer says so and points to the right one', async () => {
    const screen = await open();
    await screen.press(wrongText(0));
    expect(screen.has('Not quite. The right answer is marked in green.')).toBe(true);
    expect(screen.has('Correct')).toBe(false);
    expect(screen.has('0 of 1 correct so far')).toBe(true);
    expect(screen.labels()).toContain('Next');
  });

  it('the options lock once one is chosen, and the chosen one is marked selected', async () => {
    const screen = await open();
    const optionNodes = () => screen.renderer.root.findAll((n: ReactTestInstance) => QUESTIONS[0].options.includes(n.props.accessibilityLabel) && typeof n.props.onPress === 'function');
    expect(optionNodes().every((n) => n.props.accessibilityState.disabled === false)).toBe(true); // open before answering
    await screen.press(wrongText(0));
    expect(optionNodes().length).toBeGreaterThan(0);
    expect(optionNodes().every((n) => n.props.accessibilityState.disabled === true)).toBe(true);
    expect(optionNodes().filter((n) => n.props.accessibilityState.selected).every((n) => n.props.accessibilityLabel === wrongText(0))).toBe(true);
    expect(optionNodes().some((n) => n.props.accessibilityState.selected)).toBe(true);
    expect(screen.renderer.root.findAll((n: ReactTestInstance) => QUESTIONS[0].options.includes(n.props.accessibilityLabel) && n.type === (optionNodes()[0]?.type as unknown) && n.props.disabled === true).length).toBeGreaterThan(0); // the buttons themselves are switched off
  });

  it('Next moves to question 2 of 3 and clears the feedback', async () => {
    const screen = await open();
    await screen.press(rightText(0));
    await screen.press('Next');
    expect(screen.has('2 / 3')).toBe(true);
    expect(screen.has(QUESTIONS[1].prompt)).toBe(true);
    expect(screen.has('Correct')).toBe(false);
    expect(screen.labels()).not.toContain('Next');
  });

  it('the last question offers "See result"', async () => {
    const screen = await open();
    await screen.answer(0, 'right');
    await screen.answer(1, 'right');
    await screen.press(rightText(2));
    expect(screen.labels()).toContain('See result');
    expect(screen.labels()).not.toContain('Next');
    expect(screen.has('3 / 3')).toBe(true);
  });
});

describe('QuizScreen: Scenario: Earn the badge', () => {
  it('all correct: shows Verified, saves the record once with the topic, and plays a success haptic', async () => {
    const screen = await open();
    for (const q of [0, 1, 2]) await screen.answer(q, 'right');
    expect(screen.has('Verified')).toBe(true);
    expect(screen.has('You answered all 3 questions correctly. This article now carries a Verified badge.')).toBe(true);
    expect(screen.labels()).toContain('Done');
    expect(screen.has('1 / 3')).toBe(false); // the progress is gone
    const records = await stored();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ article_id: 'mock-1', topic: 'Research' });
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });

  it('saves once even if the screen is rendered again with another repository object', async () => {
    const make = () => ({ add: jest.fn(async (id: string) => ({ record: { article_id: id, verified_at: 'x', topic: 'Other' }, added: true })), isVerified: async () => false, list: async () => [], mergeRemote: async () => 0, subscribe: () => () => {} });
    const first = make();
    const second = make();
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    const tree = (repo: ReturnType<typeof make>) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <QuizScreen verified={repo} />
      </SafeAreaProvider>
    );
    await act(async () => {
      renderer = create(tree(first));
    });
    await act(async () => {});
    opened.push(renderer);
    const press = (label: string) =>
      act(async () => {
        renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress();
      });
    for (const q of [0, 1, 2]) {
      await press(rightText(q));
      await press(q === 2 ? 'See result' : 'Next');
    }
    expect(first.add).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(tree(second));
    });
    await act(async () => {});
    expect(first.add).toHaveBeenCalledTimes(1);
    expect(second.add).not.toHaveBeenCalled();
  });

  it('Done leaves the quiz', async () => {
    const screen = await open();
    for (const q of [0, 1, 2]) await screen.answer(q, 'right');
    await screen.press('Done');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Verify once - opening the quiz of a verified article shows the answers, so there is no second pass and no second record', async () => {
    const first = await open();
    for (const q of [0, 1, 2]) await first.answer(q, 'right');
    await act(async () => first.renderer.unmount());
    const second = await open();
    expect(second.has('Verified')).toBe(true); // the revision sheet carries the Verified mark
    expect(second.has('1 / 3')).toBe(false);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1); // only the first pass buzzed
    expect(await stored()).toHaveLength(1);
  });

  it('a failing haptic or a failing save does not break the result', async () => {
    (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error('no haptics'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { add: jest.fn().mockRejectedValue(new Error('disk full')), isVerified: async () => false, list: async () => [], mergeRemote: async () => 0, subscribe: () => () => {} };
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SafeAreaProvider initialMetrics={metrics}>
          <QuizScreen verified={failing} />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {});
    opened.push(renderer);
    const press = async (label: string) =>
      act(async () => {
        renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress();
      });
    for (const q of [0, 1, 2]) {
      await press(rightText(q));
      await press(q === 2 ? 'See result' : 'Next');
    }
    expect(renderer.root.findAllByType(Text).some((t) => t.props.children === 'Verified')).toBe(true);
    expect(failing.add).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('QuizScreen: Scenario: Fail and retry', () => {
  it('one wrong answer shows "2 of 3" with Try again and Close, gives no badge and no haptic', async () => {
    const screen = await open();
    await screen.answer(0, 'right');
    await screen.answer(1, 'wrong');
    await screen.answer(2, 'right');
    expect(screen.has('2 of 3')).toBe(true);
    expect(screen.has('Answer all 3 correctly to earn the Verified badge.')).toBe(true);
    expect(screen.labels()).toEqual(expect.arrayContaining(['Try again', 'Close']));
    expect(screen.has('Verified')).toBe(false);
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('every other score is shown the same way: 0 of 3 and 1 of 3', async () => {
    const none = await open();
    for (const q of [0, 1, 2]) await none.answer(q, 'wrong');
    expect(none.has('0 of 3')).toBe(true);
    await act(async () => none.renderer.unmount());
    const one = await open();
    await one.answer(0, 'right');
    await one.answer(1, 'wrong');
    await one.answer(2, 'wrong');
    expect(one.has('1 of 3')).toBe(true);
  });

  it('Try again restarts at question 1 with the options of every question in a new order', async () => {
    const screen = await open();
    const firstAttempt: string[][] = [];
    for (const q of [0, 1, 2]) {
      firstAttempt.push(screen.optionOrder());
      await screen.answer(q, q === 1 ? 'wrong' : 'right');
    }
    await screen.press('Try again');
    expect(screen.has('1 / 3')).toBe(true);
    expect(screen.has('2 of 3')).toBe(false);
    const secondAttempt: string[][] = [];
    for (const q of [0, 1, 2]) {
      secondAttempt.push(screen.optionOrder());
      await screen.answer(q, 'right');
    }
    for (const q of [0, 1, 2]) {
      expect([...secondAttempt[q]].sort()).toEqual([...firstAttempt[q]].sort());
      expect(secondAttempt[q]).not.toEqual(firstAttempt[q]);
    }
    expect(screen.has('Verified')).toBe(true); // the retry can still earn the badge
    expect(await stored()).toHaveLength(1);
  });

  it('Close on the result leaves the quiz and saves nothing', async () => {
    const screen = await open();
    await screen.answer(0, 'wrong');
    await screen.answer(1, 'wrong');
    await screen.answer(2, 'wrong');
    await screen.press('Close');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
  });
});

describe('QuizScreen: leaving', () => {
  it('leaving in the middle saves nothing, and coming back starts again at question 1', async () => {
    const screen = await open();
    await screen.answer(0, 'right');
    await screen.answer(1, 'right');
    await screen.press(rightText(2)); // the last answer is in, but the result was not reached
    await screen.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    await act(async () => screen.renderer.unmount()); // the screen goes away
    const again = await open();
    expect(again.has('1 / 3')).toBe(true);
    expect(again.has('Correct')).toBe(false);
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
  });

  it('with nothing to go back to, Back opens the feed', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const screen = await open();
    await screen.press('Back');
    expect(mockRouter.replace).toHaveBeenCalledWith('/feed');
  });
});

describe('QuizScreen: when there is no quiz to run', () => {
  it('an article without a quiz shows a plain message and a way back', async () => {
    const screen = await open('mock-4'); // a mock article without a quiz
    expect(screen.has('No quiz for this article')).toBe(true);
    expect(screen.labels()).toEqual(['Back']);
    expect(screen.has('1 / 3')).toBe(false);
  });

  it('an unknown article says so', async () => {
    const screen = await open('nobody');
    expect(screen.has('Article not found')).toBe(true);
    expect(screen.labels()).toEqual(['Back']);
  });
});

describe('QuizScreen: network', () => {
  it('taking the whole quiz makes no network request', async () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    try {
      const screen = await open();
      for (const q of [0, 1, 2]) await screen.answer(q, 'right');
    } finally {
      global.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});


describe('QuizScreen: Revision view of a verified article', () => {
  const verifyFirst = async () => {
    await createVerifiedRepository(AsyncStorage).add('mock-1', 'Research');
    jest.clearAllMocks();
  };
  const optionNodes = (screen: Awaited<ReturnType<typeof open>>) => screen.renderer.root.findAll((n: ReactTestInstance) => typeof n.props.accessibilityLabel === 'string' && n.props.accessible === true && typeof n.type === 'string');

  it('shows all three questions with their four options, and marks each right answer', async () => {
    await verifyFirst();
    const screen = await open();
    for (const [q, question] of QUESTIONS.entries()) {
      expect(screen.has(`QUESTION ${q + 1}`)).toBe(true);
      expect(screen.has(question.prompt)).toBe(true);
      for (const [i, option] of question.options.entries()) {
        expect(screen.has(option)).toBe(true);
        const label = i === question.correct_index ? `${option}, correct answer` : option;
        expect(optionNodes(screen).some((n) => n.props.accessibilityLabel === label)).toBe(true);
      }
    }
    expect(optionNodes(screen).filter((n) => /, correct answer$/.test(n.props.accessibilityLabel))).toHaveLength(3); // one per question
    expect(screen.has('The right answers are marked in green.')).toBe(true);
  });

  it('shows the options in the order they are stored, the same every time', async () => {
    await verifyFirst();
    const first = await open();
    const order = QUESTIONS.flatMap((q) => q.options);
    const shown = (s: typeof first) => s.texts().filter((t) => order.includes(t));
    expect(shown(first)).toEqual(order);
    await act(async () => first.renderer.unmount());
    expect(shown(await open())).toEqual(order);
  });

  it('is read-only: nothing to answer, no Next, no Try again, no progress, and nothing is written or played', async () => {
    await verifyFirst();
    const setItem = AsyncStorage.setItem as jest.Mock;
    setItem.mockClear();
    const screen = await open();
    expect(screen.labels()).toEqual(['Back']); // only the way out
    expect(screen.renderer.root.findAll((n: ReactTestInstance) => QUESTIONS.some((q) => q.options.includes(n.props.accessibilityLabel)) && typeof n.props.onPress === 'function')).toHaveLength(0);
    expect(screen.has('1 / 3')).toBe(false);
    expect(screen.has('Next')).toBe(false);
    expect(screen.has('Try again')).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(await stored()).toHaveLength(1);
  });

  it('the Article pill leaves it', async () => {
    await verifyFirst();
    const screen = await open();
    await screen.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('only the verified article is shown as revision; another article still runs as a quiz', async () => {
    await verifyFirst();
    const other = await open('mock-2');
    expect(other.has('1 / 3')).toBe(true);
    expect(other.has('The right answers are marked in green.')).toBe(false);
  });

  it('a verified article whose quiz is gone shows the plain message', async () => {
    await createVerifiedRepository(AsyncStorage).add('mock-4', 'Cloud');
    const screen = await open('mock-4');
    expect(screen.has('No quiz for this article')).toBe(true);
  });

  it('while the store is still being read, neither the quiz nor the answers are shown', async () => {
    let release!: () => void;
    const slow = {
      list: () => new Promise<never[]>((resolve) => (release = () => resolve([]))),
      isVerified: async () => false,
      add: jest.fn(),
      subscribe: () => () => {},
    };
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SafeAreaProvider initialMetrics={metrics}>
          <QuizScreen verified={slow as never} />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {});
    opened.push(renderer);
    const shown = () => renderer.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
    expect(shown()).not.toContain('1 / 3');
    expect(shown()).not.toContain('The right answers are marked in green.');
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1); // a spinner while it waits
    await act(async () => release());
    await act(async () => {});
    expect(shown()).toContain('1 / 3'); // not verified: the quiz runs
  });

  it('when the stored records cannot be read, the quiz runs as normal', async () => {
    await AsyncStorage.setItem('swipy:verified', 'not json {');
    const screen = await open();
    expect(screen.has('1 / 3')).toBe(true);
  });

  it('passing the quiz keeps the result on screen, and does not flip it to the revision view', async () => {
    const screen = await open();
    for (const q of [0, 1, 2]) await screen.answer(q, 'right');
    expect(await stored()).toHaveLength(1); // now verified in the store...
    expect(screen.has('Done')).toBe(true); // ...but the result is still what is shown
    expect(screen.has('The right answers are marked in green.')).toBe(false);
  });
});

describe('QuizScreen: Leaving by any route saves nothing', () => {
  // Every point of a run: the swipe-back gesture, Android's back button or the system closing the screen all just
  // remove the screen, so this removes it without pressing anything.
  type Screen = Awaited<ReturnType<typeof open>>;
  const stages: Array<[string, (screen: Screen) => Promise<void>]> = [
    ['before answering', async () => {}],
    ['right after a correct answer', async (screen) => screen.press(rightText(0))],
    ['after a wrong answer', async (screen) => screen.press(wrongText(0))],
    ['on the third question', async (screen) => {
      await screen.answer(0, 'right');
      await screen.answer(1, 'right');
    }],
    ['with all three answered right but "See result" not pressed', async (screen) => {
      await screen.answer(0, 'right');
      await screen.answer(1, 'right');
      await screen.press(rightText(2));
    }],
  ];
  it.each(stages)('closing the screen %s stores nothing and plays nothing', async (_name, play) => {
    const screen = await open();
    await play(screen);
    await act(async () => screen.renderer.unmount());
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    const again = await open();
    expect(again.has('1 / 3')).toBe(true);
    expect(again.has('Correct')).toBe(false);
  });

  it('closing the failed result without pressing anything saves nothing either', async () => {
    const screen = await open();
    for (const q of [0, 1, 2]) await screen.answer(q, 'wrong');
    await act(async () => screen.renderer.unmount());
    expect(await AsyncStorage.getItem('swipy:verified')).toBeNull();
  });

  it('the screen is set up so the swipe-back gesture cannot dismiss it', () => {
    const { QUIZ_SCREEN_OPTIONS } = require('./quizRoute');
    expect(QUIZ_SCREEN_OPTIONS.gestureEnabled).toBe(false);
    expect(QUIZ_SCREEN_OPTIONS.presentation).toBe('fullScreenModal');
    const layout = require('fs').readFileSync(require('path').join(__dirname, '../../../app/_layout.tsx'), 'utf8');
    expect(layout).toMatch(/<Stack\.Screen name="quiz\/\[id\]" options=\{QUIZ_SCREEN_OPTIONS\}/); // and the layout uses it
  });
});

describe('QuizScreen: large text', () => {
  // The test ScrollView has no scrolling of its own, so give it a method to watch.
  const scrollToEnd = jest.fn();
  beforeEach(() => {
    scrollToEnd.mockClear();
    (ScrollView as unknown as { prototype: Record<string, unknown> }).prototype.scrollToEnd = scrollToEnd;
  });
  afterEach(() => {
    delete (ScrollView as unknown as { prototype: Record<string, unknown> }).prototype.scrollToEnd;
  });

  it('scrolls to the end after an answer, so the feedback is not left under the Next bar', async () => {
    const screen = await open();
    expect(scrollToEnd).not.toHaveBeenCalled();
    await screen.press(wrongText(0));
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    await screen.press('Next');
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // a fresh question starts at the top
    await screen.press(rightText(1));
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('survives a scroll view that cannot scroll', async () => {
    delete (ScrollView as unknown as { prototype: Record<string, unknown> }).prototype.scrollToEnd;
    const screen = await open();
    await screen.press(wrongText(0));
    expect(screen.labels()).toContain('Next');
  });

  it('the result buttons wrap onto a second line instead of squeezing', async () => {
    const screen = await open();
    for (const q of [0, 1, 2]) await screen.answer(q, 'wrong');
    const row = screen.renderer.root.findAll((n: ReactTestInstance) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.flexWrap === 'wrap');
    expect(row.length).toBeGreaterThan(0);
  });
});

// ---- Feature 9: passing the quiz queues a verification for the leaderboard ----------------------------

const fakeQueue = () => {
  const events: string[] = [];
  const queue = {
    enqueue: jest.fn(async (articleId: string, verifiedAt?: string) => void events.push(`enqueue ${articleId} ${verifiedAt}`)),
    flush: jest.fn(async () => (events.push('flush'), { sent: 0, rejected: 0, remaining: 0 })),
    clear: jest.fn(async () => {}),
    hold: jest.fn(async () => () => {}),
  };
  return { queue: queue as SyncQueue, events, enqueue: queue.enqueue, flush: queue.flush };
};
const pass = async (screen: Awaited<ReturnType<typeof open>>) => {
  for (const q of [0, 1, 2]) await screen.answer(q, 'right');
};

describe('QuizScreen: leaderboard sync', () => {
  it('Scenario: queued after the local save - the record is on the device before the verification is queued, then a send is tried', async () => {
    const fake = fakeQueue();
    let recordedWhenQueued: unknown;
    fake.enqueue.mockImplementationOnce(async (articleId, verifiedAt) => {
      recordedWhenQueued = await stored(); // what is on the device at the moment of queueing
      fake.events.push(`enqueue ${articleId} ${verifiedAt}`);
    });
    const screen = await open('mock-1', fake.queue);
    await pass(screen);
    const [record] = await stored();
    expect(recordedWhenQueued).toHaveLength(1); // saved first
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(fake.events).toEqual([`enqueue mock-1 ${record.verified_at}`, 'flush']); // the same time as the local record, then a send
    expect(screen.has('Verified')).toBe(true);
  });

  it('the queued time is the time on the saved record, not the time of queueing', async () => {
    const fake = fakeQueue();
    const fixed = { add: jest.fn(async (id: string) => ({ record: { article_id: id, verified_at: '2026-10-01T08:15:00.000Z', topic: 'Other' }, added: true })), isVerified: async () => false, list: async () => [], mergeRemote: async () => 0, subscribe: () => () => {} };
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SafeAreaProvider initialMetrics={metrics}><QuizScreen verified={fixed} sync={fake.queue} /></SafeAreaProvider>);
    });
    await act(async () => {});
    opened.push(renderer);
    const press = (label: string) => act(async () => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress());
    for (const q of [0, 1, 2]) {
      await press(rightText(q));
      await press(q === 2 ? 'See result' : 'Next');
    }
    expect(fake.enqueue).toHaveBeenCalledWith('mock-1', '2026-10-01T08:15:00.000Z');
  });

  it('a failed quiz queues nothing and sends nothing', async () => {
    const fake = fakeQueue();
    const screen = await open('mock-1', fake.queue);
    await screen.answer(0, 'right');
    await screen.answer(1, 'wrong');
    await screen.answer(2, 'right');
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect(fake.flush).not.toHaveBeenCalled();
  });

  it('leaving in the middle queues nothing, even with every answer right so far', async () => {
    const fake = fakeQueue();
    const screen = await open('mock-1', fake.queue);
    await screen.answer(0, 'right');
    await screen.answer(1, 'right');
    await screen.press(rightText(2));
    await screen.press('Back');
    await act(async () => screen.renderer.unmount());
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect(fake.flush).not.toHaveBeenCalled();
  });

  it('it is queued once per pass, however the screen redraws', async () => {
    const fake = fakeQueue();
    const screen = await open('mock-1', fake.queue);
    await pass(screen);
    await act(async () => screen.renderer.update(<SafeAreaProvider initialMetrics={metrics}><QuizScreen verified={verified()} sync={fake.queue} /></SafeAreaProvider>));
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(fake.flush).toHaveBeenCalledTimes(1);
  });

  it('if the badge could not be saved on the device, nothing is queued: the reader would be on the board without one', async () => {
    const fake = fakeQueue();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { add: jest.fn().mockRejectedValue(new Error('disk full')), isVerified: async () => false, list: async () => [], mergeRemote: async () => 0, subscribe: () => () => {} };
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SafeAreaProvider initialMetrics={metrics}><QuizScreen verified={failing} sync={fake.queue} /></SafeAreaProvider>);
    });
    await act(async () => {});
    opened.push(renderer);
    const press = (label: string) => act(async () => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress());
    for (const q of [0, 1, 2]) {
      await press(rightText(q));
      await press(q === 2 ? 'See result' : 'Next');
    }
    expect(renderer.root.findAllByType(Text).some((t) => t.props.children === 'Verified')).toBe(true); // the result still shows
    expect(fake.enqueue).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an article that was already verified is not queued again', async () => {
    const fake = fakeQueue();
    const again = { add: jest.fn(async (id: string) => ({ record: { article_id: id, verified_at: '2026-10-01T00:00:00.000Z', topic: 'Other' }, added: false })), isVerified: async () => false, list: async () => [], mergeRemote: async () => 0, subscribe: () => () => {} };
    mockParams = { id: 'mock-1' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SafeAreaProvider initialMetrics={metrics}><QuizScreen verified={again} sync={fake.queue} /></SafeAreaProvider>);
    });
    await act(async () => {});
    opened.push(renderer);
    const press = (label: string) => act(async () => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress());
    for (const q of [0, 1, 2]) {
      await press(rightText(q));
      await press(q === 2 ? 'See result' : 'Next');
    }
    expect(again.add).toHaveBeenCalledTimes(1);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('a queue or send that fails never spoils the result, the badge or the haptic', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { enqueue: jest.fn().mockRejectedValue(new Error('outbox broke')), flush: jest.fn().mockRejectedValue(new Error('send broke')) } as unknown as SyncQueue;
    const screen = await open('mock-1', broken);
    await pass(screen);
    expect(screen.has('Verified')).toBe(true);
    expect(await stored()).toHaveLength(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const flushBroken = { enqueue: jest.fn(async () => {}), flush: jest.fn().mockRejectedValue(new Error('send broke')) } as unknown as SyncQueue;
    await act(async () => screen.renderer.unmount());
    await AsyncStorage.clear();
    const second = await open('mock-1', flushBroken);
    await pass(second);
    expect(second.has('Verified')).toBe(true);
  });

  it('Scenario: Verify offline - with the network off the badge is granted at once and the verification waits, then goes when the network returns', async () => {
    let answer: PostResult = 'retry'; // the server cannot be reached
    const posted: Array<{ device_id: string; display_name: string; article_id: string; verified_at: string }> = [];
    const api: LeaderboardApi = { postVerification: async (v) => (posted.push(v), answer), getLeaderboard: async () => ({ rows: [], you: null }) };
    const queue = createSyncQueue({ storage: AsyncStorage, api, getDeviceId: async () => '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', getDisplayName: async () => 'Maya Chen' });
    const screen = await open('mock-1', queue);
    await pass(screen);
    // the badge is there at once: the result, the saved record, and the article's own state
    expect(screen.has('Verified')).toBe(true);
    const [record] = await stored();
    expect(record).toMatchObject({ article_id: 'mock-1' });
    expect(await createVerifiedRepository(AsyncStorage).isVerified('mock-1')).toBe(true);
    // and the verification is waiting on the device
    await act(async () => {});
    expect(JSON.parse((await AsyncStorage.getItem('swipy:verify_outbox'))!)).toEqual([{ article_id: 'mock-1', verified_at: record.verified_at }]);
    expect(posted).toHaveLength(1); // one attempt was made and refused
    // the network returns
    answer = 'sent';
    expect(await queue.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ device_id: '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', display_name: 'Maya Chen', article_id: 'mock-1', verified_at: record.verified_at });
    expect(JSON.parse((await AsyncStorage.getItem('swipy:verify_outbox'))!)).toEqual([]);
  });

  it('with the network on, a pass is sent straight away', async () => {
    const posted: string[] = [];
    const api: LeaderboardApi = { postVerification: async (v) => (posted.push(v.article_id), 'sent'), getLeaderboard: async () => ({ rows: [], you: null }) };
    const queue = createSyncQueue({ storage: AsyncStorage, api, getDeviceId: async () => '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', getDisplayName: async () => undefined });
    const screen = await open('mock-1', queue);
    await pass(screen);
    await act(async () => {});
    expect(posted).toEqual(['mock-1']);
  });

  it('passing does not wait for the network: the result is up while the send is still pending', async () => {
    const api: LeaderboardApi = { postVerification: () => new Promise<PostResult>(() => {}), getLeaderboard: async () => ({ rows: [], you: null }) };
    const queue = createSyncQueue({ storage: AsyncStorage, api, getDeviceId: async () => '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90', getDisplayName: async () => undefined });
    const screen = await open('mock-1', queue);
    await pass(screen);
    expect(screen.has('Verified')).toBe(true);
    expect(screen.labels()).toContain('Done');
  });
});
