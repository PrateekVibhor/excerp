import { act, create } from 'react-test-renderer';
import type { Quiz } from '../../data';
import { shuffledOrder, useQuiz } from './useQuiz';

const QUIZ: Quiz = {
  questions: [0, 1, 2].map((n) => ({
    prompt: `Question ${n}?`,
    options: ['a', 'b', 'c', 'd'].map((o) => `${o}${n}`),
    correct_index: n, // q0 -> "a0", q1 -> "b1", q2 -> "c2"
  })),
};

/** A random source that cycles through the given values. */
const cycle = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('shuffledOrder', () => {
  it('is always a permutation of 0..n-1', () => {
    for (const seed of [0, 0.1, 0.5, 0.99]) {
      const order = shuffledOrder(4, undefined, cycle(seed, 0.3, 0.7));
      expect([...order].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it('moves things around: not always the order it started in', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(shuffledOrder(4, undefined, Math.random).join(''));
    expect(seen.size).toBeGreaterThan(5);
  });

  it('never returns the previous order, even when the dice land on it', () => {
    // random() = 0.99 keeps every element in place, so the shuffle is the identity [0,1,2,3]
    const sameAsPrevious = shuffledOrder(4, [0, 1, 2, 3], () => 0.99);
    expect(sameAsPrevious).not.toEqual([0, 1, 2, 3]);
    expect([...sameAsPrevious].sort()).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < 200; i++) {
      const previous = shuffledOrder(4, undefined, Math.random);
      expect(shuffledOrder(4, previous, Math.random)).not.toEqual(previous);
    }
  });

  it('a different previous order is left alone', () => {
    expect(shuffledOrder(4, [3, 2, 1, 0], () => 0.99)).toEqual([0, 1, 2, 3]);
  });

  it('copes with a random source that returns exactly 1', () => {
    expect([...shuffledOrder(4, undefined, () => 1)].sort()).toEqual([0, 1, 2, 3]);
  });
});

async function mount(random: () => number = Math.random) {
  const out = { run: undefined as never as ReturnType<typeof useQuiz> };
  function Harness() {
    out.run = useQuiz(QUIZ, random);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return { out, renderer };
}
const call = (fn: () => void) => act(() => fn());
/** The display position of the right option on the current question. */
const rightAt = (run: ReturnType<typeof useQuiz>) => run.options.findIndex((o) => o.correct);
const wrongAt = (run: ReturnType<typeof useQuiz>) => run.options.findIndex((o) => !o.correct);

describe('useQuiz', () => {
  it('starts on question 1 of 3 with four options, exactly one of them right', async () => {
    const { out } = await mount();
    expect(out.run.phase).toBe('question');
    expect([out.run.number, out.run.total]).toEqual([1, 3]);
    expect(out.run.options).toHaveLength(4);
    expect(out.run.options.filter((o) => o.correct)).toHaveLength(1);
    expect(out.run.options.find((o) => o.correct)?.text).toBe('a0');
    expect(out.run.picked).toBeNull();
    expect(out.run.lastCorrect).toBeNull();
  });

  it('shows the options in a shuffled order, with the right one wherever it lands', async () => {
    const { out } = await mount(() => 0); // random 0 swaps each element with the first
    const texts = out.run.options.map((o) => o.text);
    expect([...texts].sort()).toEqual(['a0', 'b0', 'c0', 'd0']);
    expect(texts).not.toEqual(['a0', 'b0', 'c0', 'd0']);
    expect(out.run.options.find((o) => o.correct)?.text).toBe('a0'); // still the one marked right
  });

  it('answering shows right or wrong at once, and locks the question', async () => {
    const { out } = await mount();
    await call(() => out.run.choose(rightAt(out.run)));
    expect(out.run.phase).toBe('answered');
    expect(out.run.lastCorrect).toBe(true);
    expect([out.run.answered, out.run.score]).toEqual([1, 1]);
    await call(() => out.run.choose(wrongAt(out.run))); // a second tap changes nothing
    expect(out.run.lastCorrect).toBe(true);
    expect([out.run.answered, out.run.score]).toEqual([1, 1]);
  });

  it('a wrong answer is marked wrong and not counted', async () => {
    const { out } = await mount();
    await call(() => out.run.choose(wrongAt(out.run)));
    expect(out.run.lastCorrect).toBe(false);
    expect([out.run.answered, out.run.score]).toEqual([1, 0]);
  });

  it('Next moves on only after an answer; an unknown option does nothing', async () => {
    const { out } = await mount();
    await call(() => out.run.next());
    expect(out.run.number).toBe(1);
    await call(() => out.run.choose(7));
    expect(out.run.phase).toBe('question');
    await call(() => out.run.choose(0));
    await call(() => out.run.next());
    expect([out.run.number, out.run.phase, out.run.picked]).toEqual([2, 'question', null]);
  });

  it('after the third answer the result comes only once Next is pressed, and all-correct passes', async () => {
    const { out } = await mount();
    for (let q = 0; q < 3; q++) {
      await call(() => out.run.choose(rightAt(out.run)));
      expect(out.run.phase).toBe('answered'); // feedback is shown, even on the last one
      expect(out.run.isLast).toBe(q === 2);
      await call(() => out.run.next());
    }
    expect(out.run.phase).toBe('result');
    expect([out.run.score, out.run.total, out.run.passed]).toEqual([3, 3, true]);
  });

  it('is not passed until the result is reached, even with every answer right', async () => {
    const { out } = await mount();
    for (let q = 0; q < 3; q++) {
      await call(() => out.run.choose(rightAt(out.run)));
      expect(out.run.passed).toBe(false); // the last answer is in, the result is not
      if (q < 2) await call(() => out.run.next());
    }
    expect(out.run.score).toBe(3);
    await call(() => out.run.next());
    expect(out.run.passed).toBe(true);
  });

  it('one wrong answer ends with 2 of 3 and no pass', async () => {
    const { out } = await mount();
    for (const pick of [rightAt, wrongAt, rightAt]) {
      await call(() => out.run.choose(pick(out.run)));
      await call(() => out.run.next());
    }
    expect(out.run.phase).toBe('result');
    expect([out.run.score, out.run.passed]).toEqual([2, false]);
  });

  it('Try again starts over at question 1 with every question\'s options in a new order', async () => {
    const { out } = await mount();
    const firstOrders: string[][] = [];
    for (let q = 0; q < 3; q++) {
      firstOrders.push(out.run.options.map((o) => o.text));
      await call(() => out.run.choose(q === 1 ? wrongAt(out.run) : rightAt(out.run)));
      await call(() => out.run.next());
    }
    expect(out.run.score).toBe(2);
    await call(() => out.run.restart());
    expect([out.run.phase, out.run.number, out.run.answered, out.run.score, out.run.passed]).toEqual(['question', 1, 0, 0, false]);
    const secondOrders: string[][] = [];
    for (let q = 0; q < 3; q++) {
      secondOrders.push(out.run.options.map((o) => o.text));
      await call(() => out.run.choose(rightAt(out.run)));
      await call(() => out.run.next());
    }
    for (let q = 0; q < 3; q++) {
      expect([...secondOrders[q]].sort()).toEqual([...firstOrders[q]].sort()); // same options
      expect(secondOrders[q]).not.toEqual(firstOrders[q]); // new order, on every question
    }
    expect(out.run.passed).toBe(true);
  });

  it('reshuffles even when the dice would repeat the order', async () => {
    const { out } = await mount(() => 0.99); // identity order every time
    const before = out.run.options.map((o) => o.text);
    await call(() => out.run.restart());
    expect(out.run.options.map((o) => o.text)).not.toEqual(before);
  });
});
