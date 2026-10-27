/** @jest-environment node */
// The mock-data flows name articles by title and tap quiz answers by their text. This checks those texts against the app's real
// sample data, so a changed quiz, title or sort order fails a unit test before it fails a flow (spec 12).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mockArticles } from '../data/mockArticles';
import { FALLBACK_NAME } from '../data/syncQueue';

// FALLBACK_NAME comes from the module that also holds the storage code, which needs the library's own mock in a unit test.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const flowsDir = join(__dirname, '..', '..', 'e2e', 'flows', 'mock');
const read = (name: string) => readFileSync(join(flowsDir, name), 'utf8');
/** Every quoted text in the flow, in order of appearance. */
const quoted = (text: string) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

// The Feed shows the newest article first (useFeed sorts on published_at), so this is the order of the cards.
const feedOrder = [...mockArticles].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
const titles = feedOrder.map((a) => a.title);
const quizCard = feedOrder.findIndex((a) => a.quiz); // the first card that has a quiz
const quizArticle = feedOrder[quizCard];

describe('the flows that use the built-in sample data', () => {
  it('there are four of them: swipe, all caught up, quiz pass, quiz fail', () => {
    expect(readdirSync(flowsDir).filter((f) => f.endsWith('.yaml')).sort()).toEqual(['10-feed-swipe.yaml', '11-all-caught-up.yaml', '12-quiz-pass.yaml', '13-quiz-fail.yaml']);
  });

  it('every article title a flow names is a real sample title', () => {
    for (const file of readdirSync(flowsDir).filter((f) => f.endsWith('.yaml'))) {
      const answers = new Set(mockArticles.flatMap((x) => x.quiz?.questions.flatMap((q) => q.options) ?? []));
      const named = quoted(read(file)).filter((t) => /^[A-Z].{25,}/.test(t) && !answers.has(t) && !/^(Welcome|Waiting|Sign|Choose|Test reader|You answered|You're|Question|Not quite)/.test(t));
      for (const t of named) expect(titles).toContain(t);
    }
  });

  it('the first card is the newest article, as flows 10 and 11 expect', () => {
    expect(titles[0]).toBe('Open Model Weights Released for On-Device Use');
    expect(titles[1]).toBe('Building a Retrieval Pipeline with Managed Vector Search');
    expect(read('10-feed-swipe.yaml')).toContain(`"${titles[0]}"`);
    expect(read('10-feed-swipe.yaml')).toContain(`"${titles[1]}"`);
  });

  it('flow 11 goes through all nine cards in the Feed\'s own order, and counts them', () => {
    const named = quoted(read('11-all-caught-up.yaml')).filter((t) => titles.includes(t));
    const inOrder = named.filter((t, i) => i === 0 || t !== named[i - 1]); // a title can be waited for and then asserted
    expect(inOrder).toEqual(titles);
    expect(quoted(read('10-feed-swipe.yaml'))).toContain(`${mockArticles.length} NEW`);
  });

  it('flow 11 checks the end-of-feed summary: all nine stories reviewed, one saved (the second card, swiped right)', () => {
    expect(quoted(read('11-all-caught-up.yaml'))).toContain(`${mockArticles.length} stories reviewed · 1 saved this session`);
  });

  it('the quiz flows use the first card with a quiz, which is the fourth', () => {
    expect(quizCard).toBe(3);
    for (const file of ['12-quiz-pass.yaml', '13-quiz-fail.yaml']) {
      expect(quoted(read(file))).toContain(quizArticle.title);
      expect(read(file)).toMatch(/Skip/); // the three cards before it are skipped
    }
  });

  it('Scenario: Flow data matches the app - flow 12 taps only the correct answer of each question, in order', () => {
    const questions = quizArticle.quiz!.questions;
    const correct = questions.map((q) => q.options[q.correct_index]);
    const optionTexts = new Set(questions.flatMap((q) => q.options));
    const tapped = quoted(read('12-quiz-pass.yaml')).filter((t) => optionTexts.has(t));
    expect(tapped).toEqual(correct);
  });

  it('flow 13 taps one wrong answer first, then the correct answers for the other questions', () => {
    const questions = quizArticle.quiz!.questions;
    const optionTexts = new Set(questions.flatMap((q) => q.options));
    const tapped = quoted(read('13-quiz-fail.yaml')).filter((t) => optionTexts.has(t));
    expect(tapped).toHaveLength(questions.length);
    expect(tapped[0]).not.toBe(questions[0].options[questions[0].correct_index]);
    expect(questions[0].options).toContain(tapped[0]);
    expect(tapped.slice(1)).toEqual(questions.slice(1).map((q) => q.options[q.correct_index]));
  });

  it('flow 13 expects the score it will get: all but one question right', () => {
    const questions = quizArticle.quiz!.questions;
    expect(read('13-quiz-fail.yaml')).toContain(`"${questions.length - 1} of ${questions.length}"`);
  });

  it('an option text is never also an article title, so a tap cannot mean the wrong thing', () => {
    const options = mockArticles.flatMap((a) => a.quiz?.questions.flatMap((q) => q.options) ?? []);
    for (const o of options) expect(titles).not.toContain(o);
  });
});

describe('the leaderboard flows (on the test server, which holds the same sample articles)', () => {
  const apiDir = join(__dirname, '..', '..', 'e2e', 'flows', 'api');
  const readApi = (name: string) => readFileSync(join(apiDir, name), 'utf8');
  const quizTexts = new Set(quizArticle.quiz!.questions.flatMap((q) => q.options));

  it('there are two of them: a verified reader on the board, and the board\'s states', () => {
    const names = readdirSync(apiDir).filter((f) => f.startsWith('05-') || f.startsWith('06-')).sort();
    expect(names).toEqual(['05-leaderboard-shows-reader.yaml', '06-leaderboard-states.yaml']);
  });

  it('flow 05 skips the three cards before the quiz card, opens it, and taps only the correct answers in order', () => {
    const text = readApi('05-leaderboard-shows-reader.yaml');
    expect(quoted(text)).toContain(quizArticle.title);
    expect((text.match(/tapOn: "Skip"/g) ?? []).length).toBe(quizCard);
    const correct = quizArticle.quiz!.questions.map((q) => q.options[q.correct_index]);
    expect(quoted(text).filter((t) => quizTexts.has(t))).toEqual(correct);
  });

  it('flow 05 expects the reader on the board with the name the app sends when there is no profile, and a count of 1', () => {
    expect(readApi('05-leaderboard-shows-reader.yaml')).toContain(`"1. ${FALLBACK_NAME}, 1 verified, you"`);
  });

  it('every article title the leaderboard flows name is a real sample title', () => {
    for (const file of ['05-leaderboard-shows-reader.yaml', '06-leaderboard-states.yaml']) {
      const named = quoted(readApi(file)).filter((t) => /^[A-Z].{25,}/.test(t) && !quizTexts.has(t) && !/^(Welcome|Waiting|Sign|Choose|Test reader|You answered|You're|Question|Not quite|No verified|Couldn)/.test(t));
      for (const t of named) expect(titles).toContain(t);
    }
  });
});

