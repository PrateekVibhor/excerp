import { useCallback, useReducer, useRef } from 'react';
import type { Quiz, QuizQuestion } from '../../data';

export type QuizPhase = 'question' | 'answered' | 'result';

export interface QuizOption {
  text: string;
  correct: boolean;
}

/**
 * A random order for `length` items that is never the order of `previous`, so Try again always shows the
 * options moved. When a shuffle lands on the old order, it is rotated by one place.
 */
export function shuffledOrder(length: number, previous: readonly number[] | undefined, random: () => number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (previous && length > 1 && order.every((value, i) => value === previous[i])) order.push(order.shift()!);
  return order;
}

interface State {
  /** For each question, the order its options are shown in: `orders[q][position]` is an index into `options`. */
  orders: number[][];
  index: number;
  /** The position the reader tapped on the current question, or null before answering. */
  picked: number | null;
  /** One entry per question answered so far. */
  results: boolean[];
  finished: boolean;
}

type Action = { type: 'choose'; position: number } | { type: 'next' } | { type: 'restart'; orders: number[][] };

const newOrders = (quiz: Quiz, previous: number[][] | undefined, random: () => number) =>
  quiz.questions.map((q, i) => shuffledOrder(q.options.length, previous?.[i], random));

const optionsOf = (question: QuizQuestion, order: readonly number[]): QuizOption[] =>
  order.map((i) => ({ text: question.options[i], correct: i === question.correct_index }));

function reducerFor(quiz: Quiz) {
  return (state: State, action: Action): State => {
    switch (action.type) {
      case 'choose': {
        if (state.finished || state.picked !== null) return state; // one answer per question
        const options = optionsOf(quiz.questions[state.index], state.orders[state.index]);
        if (!options[action.position]) return state;
        return { ...state, picked: action.position, results: [...state.results, options[action.position].correct] };
      }
      case 'next': {
        if (state.finished || state.picked === null) return state; // only after answering
        if (state.index === quiz.questions.length - 1) return { ...state, finished: true };
        return { ...state, index: state.index + 1, picked: null };
      }
      case 'restart':
        return { orders: action.orders, index: 0, picked: null, results: [], finished: false };
    }
  };
}

/**
 * The state of one run through a quiz: which question, the option order for this attempt, what was picked.
 * Nothing is saved here. Leaving the screen mid-quiz drops all of it.
 */
export function useQuiz(quiz: Quiz, random: () => number = Math.random) {
  const rng = useRef(random);
  rng.current = random;
  const reducer = useRef(reducerFor(quiz));
  reducer.current = reducerFor(quiz);
  const [state, dispatch] = useReducer((s: State, a: Action) => reducer.current(s, a), undefined, (): State => ({
    orders: newOrders(quiz, undefined, random),
    index: 0,
    picked: null,
    results: [],
    finished: false,
  }));

  const total = quiz.questions.length;
  const question = quiz.questions[state.index];
  const options = optionsOf(question, state.orders[state.index]);
  const phase: QuizPhase = state.finished ? 'result' : state.picked === null ? 'question' : 'answered';
  const score = state.results.filter(Boolean).length;

  return {
    phase,
    total,
    /** 1-based, for "1 / 3". */
    number: state.index + 1,
    question,
    options,
    picked: state.picked,
    /** Whether the answer just given was right; null before answering. */
    lastCorrect: state.picked === null ? null : options[state.picked].correct,
    answered: state.results.length,
    score,
    passed: state.finished && score === total,
    isLast: state.index === total - 1,
    choose: useCallback((position: number) => dispatch({ type: 'choose', position }), []),
    next: useCallback(() => dispatch({ type: 'next' }), []),
    /** Starts over with every question's options in a different order than last time. */
    restart: useCallback(() => dispatch({ type: 'restart', orders: newOrders(quiz, state.orders, rng.current) }), [quiz, state.orders]),
  };
}
