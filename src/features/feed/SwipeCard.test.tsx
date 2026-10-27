import { createRef } from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { createMockRepositories } from '../../data/mockRepository';
import type { Article } from '../../data';
import { SwipeCard, type SwipeCardHandle } from './SwipeCard';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

let article: Article;

beforeAll(async () => {
  article = (await createMockRepositories().articles.getFeed('u'))[0];
});

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

function mount(onSwipe: jest.Mock) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<SwipeCard article={article} onSwipe={onSwipe} />);
  });
  return renderer;
}

function dragTo(endX: number) {
  act(() => {
    fireGestureHandler(getByGestureTestId('swipe-card'), [
      { state: State.BEGAN },
      { state: State.ACTIVE, translationX: endX / 2, translationY: 0 },
      { translationX: endX, translationY: 0 },
      { state: State.END, translationX: endX, translationY: 0 },
    ]);
  });
}

function settle() {
  act(() => {
    jest.advanceTimersByTime(1000);
  });
}

function drag(onSwipe: jest.Mock, endX: number) {
  const renderer = mount(onSwipe);
  dragTo(endX);
  settle();
  act(() => renderer.unmount());
}

describe('SwipeCard gesture', () => {
  it('springs back when dragged 109 points right', () => {
    const onSwipe = jest.fn();
    drag(onSwipe, 109);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('flies off to the right when dragged 111 points', () => {
    const onSwipe = jest.fn();
    drag(onSwipe, 111);
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('flies off to the left when dragged 111 points left', () => {
    const onSwipe = jest.fn();
    drag(onSwipe, -111);
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('springs back when dragged 109 points left', () => {
    const onSwipe = jest.fn();
    drag(onSwipe, -109);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('ignores touches while the card is flying off', () => {
    const onSwipe = jest.fn();
    const renderer = mount(onSwipe);
    dragTo(200); // starts the fly-out to the right
    dragTo(-300); // a second drag mid-flight must be ignored
    settle();
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith('right');
    act(() => renderer.unmount());
  });
});

describe('SwipeCard buttons use the same fly-out as the gesture', () => {
  function mountWithHandle(onSwipe: jest.Mock) {
    const ref = createRef<SwipeCardHandle>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<SwipeCard article={article} onSwipe={onSwipe} ref={ref} />);
    });
    return { ref, renderer };
  }

  it('Save gives the same result as a right swipe', () => {
    const viaButton = jest.fn();
    const a = mountWithHandle(viaButton);
    act(() => a.ref.current!.flyOut('right'));
    settle();
    act(() => a.renderer.unmount());

    const viaGesture = jest.fn();
    drag(viaGesture, 200);

    expect(viaButton.mock.calls).toEqual(viaGesture.mock.calls);
    expect(viaButton).toHaveBeenCalledWith('right');
  });

  it('Skip gives the same result as a left swipe', () => {
    const viaButton = jest.fn();
    const a = mountWithHandle(viaButton);
    act(() => a.ref.current!.flyOut('left'));
    settle();
    act(() => a.renderer.unmount());

    const viaGesture = jest.fn();
    drag(viaGesture, -200);

    expect(viaButton.mock.calls).toEqual(viaGesture.mock.calls);
    expect(viaButton).toHaveBeenCalledWith('left');
  });

  it('ignores a second button press while the card is flying off', () => {
    const onSwipe = jest.fn();
    const { ref, renderer } = mountWithHandle(onSwipe);
    act(() => ref.current!.flyOut('right'));
    act(() => ref.current!.flyOut('left'));
    settle();
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith('right');
    act(() => renderer.unmount());
  });

  it('ignores a button press while a drag is flying off', () => {
    const onSwipe = jest.fn();
    const { ref, renderer } = mountWithHandle(onSwipe);
    dragTo(200);
    act(() => ref.current!.flyOut('left'));
    settle();
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith('right');
    act(() => renderer.unmount());
  });

  it('a card behind the top one cannot be flown off', () => {
    const onSwipe = jest.fn();
    const ref = createRef<SwipeCardHandle>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<SwipeCard article={article} depth={1} onSwipe={onSwipe} ref={ref} />);
    });
    act(() => ref.current!.flyOut('right'));
    settle();
    expect(onSwipe).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('SwipeCard tap', () => {
  const tapCard = (id = 'tap-card') =>
    act(() => {
      fireGestureHandler(getByGestureTestId(id), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
    });

  function mountTappable(onOpen: jest.Mock, onSwipe = jest.fn(), depth = 0) {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<SwipeCard article={article} depth={depth} onOpen={onOpen} onSwipe={onSwipe} />);
    });
    return renderer;
  }

  it('opens the article when the card is tapped', () => {
    const onOpen = jest.fn();
    const r = mountTappable(onOpen);
    tapCard();
    settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('a tap does not swipe the card', () => {
    const onSwipe = jest.fn();
    const r = mountTappable(jest.fn(), onSwipe);
    tapCard();
    settle();
    expect(onSwipe).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('a drag past the threshold swipes and does not open the article', () => {
    const onOpen = jest.fn();
    const onSwipe = jest.fn();
    const r = mountTappable(onOpen, onSwipe);
    dragTo(200);
    settle();
    expect(onSwipe).toHaveBeenCalledWith('right');
    expect(onOpen).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('a short drag springs back and does not open the article', () => {
    const onOpen = jest.fn();
    const onSwipe = jest.fn();
    const r = mountTappable(onOpen, onSwipe);
    dragTo(50);
    settle();
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('ignores a tap while the card is flying off', () => {
    const onOpen = jest.fn();
    const r = mountTappable(onOpen);
    dragTo(200); // starts the fly-out
    tapCard();
    settle();
    expect(onOpen).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('only the top card can be tapped open', () => {
    const onOpen = jest.fn();
    const r = mountTappable(onOpen, jest.fn(), 1);
    tapCard('tap-card-1');
    settle();
    expect(onOpen).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('uses the same 10-point distance for tap and drag, so a touch is always exactly one', () => {
    const r = mountTappable(jest.fn());
    const tap = getByGestureTestId('tap-card') as unknown as { config: { maxDist: number; enabled: boolean } };
    const pan = getByGestureTestId('swipe-card') as unknown as { config: { minDist: number } };
    expect(tap.config.maxDist).toBe(10);
    expect(pan.config.minDist).toBe(10);
    act(() => r.unmount());
  });
});

describe('SwipeCard long titles', () => {
  it('cuts a long title at three lines so it cannot push out the footer', () => {
    const longTitle = 'Memory-Efficient Distributed Training and Inference for Very Long-Context Multimodal Language Models Across Heterogeneous Accelerator Clusters at Scale';
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<SwipeCard article={{ ...article, title: longTitle }} />);
    });
    const title = renderer.root.findAll((n: ReactTestInstance) => n.props.children === longTitle || (Array.isArray(n.props.children) && n.props.children.includes?.(longTitle)));
    const withLines = title.filter((n: ReactTestInstance) => n.props.numberOfLines !== undefined);
    expect(withLines.length).toBeGreaterThan(0);
    expect(withLines[0].props.numberOfLines).toBe(3);
    act(() => renderer.unmount());
  });
});

describe('SwipeCard summary on small screens', () => {
  function mountCard() {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<SwipeCard article={article} />);
    });
    return renderer;
  }
  const summaryText = (r: ReturnType<typeof create>) =>
    r.root.findAllByType(Text).find((t: ReactTestInstance) => t.props.children === article.summary)!;
  const layoutBox = (r: ReturnType<typeof create>, height: number) =>
    act(() => {
      r.root
        .findAll((n: ReactTestInstance) => n.props.testID === 'summary-box' && typeof n.props.onLayout === 'function')[0]
        .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
    });

  it('shows the whole summary until the space it has is measured', () => {
    const r = mountCard();
    expect(summaryText(r).props.numberOfLines).toBeUndefined();
    act(() => r.unmount());
  });

  it('cuts the summary at the number of lines that fit in the space it was given', () => {
    const r = mountCard();
    layoutBox(r, 121); // 5 lines of 24.18
    expect(summaryText(r).props.numberOfLines).toBe(5);
    layoutBox(r, 145); // 5 lines still: 145 / 24.18 is 5.99
    expect(summaryText(r).props.numberOfLines).toBe(5);
    layoutBox(r, 146); // 6 lines
    expect(summaryText(r).props.numberOfLines).toBe(6);
    act(() => r.unmount());
  });

  it('allows a full summary when there is plenty of room', () => {
    const r = mountCard();
    layoutBox(r, 400);
    expect(summaryText(r).props.numberOfLines).toBeGreaterThanOrEqual(12); // more lines than a 60-word summary needs
    act(() => r.unmount());
  });

  it('always keeps at least one line, however little room there is', () => {
    const r = mountCard();
    layoutBox(r, 3);
    expect(summaryText(r).props.numberOfLines).toBe(1);
    act(() => r.unmount());
  });
});

