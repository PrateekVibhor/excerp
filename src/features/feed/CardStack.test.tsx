import { createRef } from 'react';
import { act, create } from 'react-test-renderer';
import { useSharedValue } from 'react-native-reanimated';
import { createMockRepositories } from '../../data/mockRepository';
import type { Article } from '../../data';
import { CardStack } from './CardStack';
import { SwipeCard, type SwipeCardHandle } from './SwipeCard';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

let articles: Article[];

beforeAll(async () => {
  articles = await createMockRepositories().articles.getFeed('u');
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function Harness({
  index,
  onSwipe,
  handle,
}: {
  index: number;
  onSwipe: jest.Mock;
  handle?: React.Ref<SwipeCardHandle>;
}) {
  const dragX = useSharedValue(0);
  return <CardStack ref={handle} articles={articles} index={index} dragX={dragX} onSwipe={onSwipe} />;
}

function mount(index: number, onSwipe = jest.fn(), handle?: React.Ref<SwipeCardHandle>) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Harness index={index} onSwipe={onSwipe} handle={handle} />);
  });
  return renderer;
}

const depths = (r: ReturnType<typeof create>) => r.root.findAllByType(SwipeCard).map((c) => c.props.depth);
const ids = (r: ReturnType<typeof create>) => r.root.findAllByType(SwipeCard).map((c) => c.props.article.id);

describe('CardStack', () => {
  it('shows the top card and two behind it', () => {
    const r = mount(0);
    expect(depths(r)).toEqual([0, 1, 2]);
    expect(ids(r)).toEqual(articles.slice(0, 3).map((a) => a.id));
    act(() => r.unmount());
  });

  it('shows fewer cards as the deck runs out', () => {
    const last = articles.length - 1;
    const r = mount(last);
    expect(depths(r)).toEqual([0]);
    act(() => r.unmount());
    const none = mount(articles.length);
    expect(depths(none)).toEqual([]);
    act(() => none.unmount());
  });

  it('promotes the next card to the top after a swipe', () => {
    const r = mount(0);
    act(() => {
      r.update(<Harness index={1} onSwipe={jest.fn()} />);
    });
    expect(depths(r)).toEqual([0, 1, 2]);
    expect(ids(r)).toEqual(articles.slice(1, 4).map((a) => a.id));
    act(() => r.unmount());
  });

  it('flying the top card off reports the direction and that card', () => {
    const onSwipe = jest.fn();
    const handle = createRef<SwipeCardHandle>();
    const r = mount(0, onSwipe, handle);
    act(() => handle.current!.flyOut('right'));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith('right', articles[0]);
    act(() => r.unmount());
  });
});
