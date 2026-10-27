// Executes the Gherkin scenarios of intent-4.md and spec-4.md against the real
// Feed screen and tab bar, with the mock article source and the AsyncStorage mock.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComponentProps } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GlassTabBar } from '../../components/GlassTabBar';
import { TabBadge } from '../../components/TabBadge';
import { LOCAL_USER_ID, readingListRepository, type Article } from '../../data';
import { createMockRepositories } from '../../data/mockRepository';
import { FeedScreen } from './FeedScreen';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
const mockRouter = { navigate: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, Tabs: () => null }));

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};
const tabBarProps = {
  state: { index: 0, routes: [{ key: 'feed', name: 'feed' }, { key: 'reading-list', name: 'reading-list' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
} as unknown as ComponentProps<typeof GlassTabBar>;

let newestFirst: Article[];

beforeAll(async () => {
  const feed = await createMockRepositories().articles.getFeed('x');
  newestFirst = [...feed].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
});
beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  await AsyncStorage.clear();
});
afterEach(() => jest.useRealTimers());

/** Every string rendered anywhere in the tree. */
function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}

async function launch() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <FeedScreen />
        <GlassTabBar {...tabBarProps} />
      </SafeAreaProvider>,
    );
  });
  await settle();
  return {
    renderer,
    text: () => texts(renderer.toJSON() as never),
    close: () => act(() => renderer.unmount()),
  };
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
}

async function tap() {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('tap-card'), [
      { state: State.BEGAN },
      { state: State.ACTIVE },
      { state: State.END },
    ]);
  });
}

async function drag(endX: number) {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('swipe-card'), [
      { state: State.BEGAN },
      { state: State.ACTIVE, translationX: endX / 2, translationY: 0 },
      { translationX: endX, translationY: 0 },
      { state: State.END, translationX: endX, translationY: 0 },
    ]);
  });
}

function press(app: { renderer: ReturnType<typeof create> }, label: 'Save' | 'Skip') {
  const target = app.renderer.root.findAll(
    (n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  return act(async () => target.props.onPress());
}

const savedIds = async () => (await readingListRepository.list(LOCAL_USER_ID)).map((i) => i.article_id);
const swipesStored = () => AsyncStorage.getItem('swipy:swipes');
const badgeShows = (t: string[], n: number) => t.includes(String(n));

describe('intent-4: Swipe feed', () => {
  it('Scenario: Cards are shown', async () => {
    const app = await launch();
    const top = newestFirst[0];
    const t = app.text();
    expect(t).toEqual(expect.arrayContaining([top.source_company, top.content_type, top.title, top.summary]));
    expect(t).toContain(`${top.reader_count} people are reading this`);
    expect(t).toContain('Oct 2'); // published date, "Sep 24" style
    expect(t).toContain('1 / 9');
    app.close();
  });

  it('Scenario: Swipe right saves, and the badge goes up by one', async () => {
    const app = await launch();
    expect(badgeShows(app.text(), 1)).toBe(false);
    await drag(200);
    await settle();
    expect(await savedIds()).toEqual([newestFirst[0].id]);
    expect(badgeShows(app.text(), 1)).toBe(true);
    expect(app.text()).toContain('2 / 9'); // the card flew off, the next one is on top
    app.close();
  });

  it('Scenario: Swipe left skips, and nothing is saved', async () => {
    const app = await launch();
    await drag(-200);
    await settle();
    expect(await savedIds()).toEqual([]);
    expect(app.text()).toContain('2 / 9');
    expect(await swipesStored()).toContain('"direction":"left"');
    expect(badgeShows(app.text(), 1)).toBe(false);
    app.close();
  });

  it('Scenario: Short drag cancels, and nothing is recorded', async () => {
    const app = await launch();
    await drag(50);
    await settle();
    expect(app.text()).toContain('1 / 9'); // same card still on top
    expect(await savedIds()).toEqual([]);
    expect(await swipesStored()).toBeNull();
    app.close();
  });

  it('Scenario: Feed ends gracefully', async () => {
    const app = await launch();
    for (let i = 0; i < newestFirst.length; i++) {
      await drag(i % 2 === 0 ? 200 : -200);
      await settle();
    }
    const t = app.text();
    expect(t).toContain("You're all caught up");
    expect(t).toContain('9 stories reviewed · 5 saved this session');
    expect(t).toContain('0 NEW');
    app.close();
  });
});

describe('spec-4: Swipe feed (spec level)', () => {
  it('Scenario: Threshold is 110 points', async () => {
    const app = await launch();
    await drag(109);
    await settle();
    expect(app.text()).toContain('1 / 9'); // sprang back
    expect(await savedIds()).toEqual([]);

    await drag(111);
    await settle();
    expect(app.text()).toContain('2 / 9'); // flew off
    expect(await savedIds()).toEqual([newestFirst[0].id]);
    app.close();
  });

  it('Scenario: Buttons match gestures', async () => {
    const viaGesture = await launch();
    await drag(200);
    await settle();
    const gestureResult = { saved: await savedIds(), text: viaGesture.text().filter((s) => /\/ 9|NEW/.test(s)) };
    viaGesture.close();
    await AsyncStorage.clear();

    const viaButton = await launch();
    await press(viaButton, 'Save');
    await settle();
    const buttonResult = { saved: await savedIds(), text: viaButton.text().filter((s) => /\/ 9|NEW/.test(s)) };
    viaButton.close();

    expect(buttonResult).toEqual(gestureResult);
    expect(buttonResult.saved).toEqual([newestFirst[0].id]);
  });

  it('Scenario: Skip button matches a left swipe', async () => {
    const app = await launch();
    await press(app, 'Skip');
    await settle();
    expect(await savedIds()).toEqual([]);
    expect(app.text()).toContain('2 / 9');
    expect(await swipesStored()).toContain('"direction":"left"');
    app.close();
  });

  it('Scenario: Persistence', async () => {
    const first = await launch();
    await drag(200); // save the newest
    await settle();
    await drag(-200); // skip the second
    await settle();
    first.close();

    const reopened = await launch(); // the app is closed and reopened
    const t = reopened.text();
    expect(t).not.toContain(newestFirst[0].title);
    expect(t).not.toContain(newestFirst[1].title);
    expect(t).toContain(newestFirst[2].title);
    expect(t).toContain('1 / 7');
    expect(badgeShows(t, 1)).toBe(true);
    reopened.close();
  });

  it('Scenario: Input during animation', async () => {
    const app = await launch();
    await drag(200); // the card starts flying off...
    await drag(-300); // ...and a touch lands on the next card before it ends
    await settle();
    expect(await savedIds()).toEqual([newestFirst[0].id]);
    expect(app.text()).toContain('2 / 9'); // exactly one card was swiped
    const swipes = JSON.parse((await swipesStored()) as string);
    expect(swipes).toHaveLength(1);
    app.close();
  });

  it('Scenario: Badge hidden at zero', async () => {
    const app = await launch();
    expect(badgeShows(app.text(), 0)).toBe(false);
    expect(app.renderer.root.findByType(TabBadge).props.count).toBe(0);
    await drag(-200); // skipping saves nothing, so there is still no badge
    await settle();
    expect(badgeShows(app.text(), 0)).toBe(false);
    expect(badgeShows(app.text(), 1)).toBe(false);
    app.close();
  });
});

describe('spec-5: Feed card taps', () => {
  it('Scenario: Tap versus drag', async () => {
    const app = await launch();

    // Moves less than 10 points and releases: a tap, so the detail screen opens.
    await tap();
    await settle();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/article/[id]',
      params: { id: newestFirst[0].id, from: 'feed' },
    });
    expect(app.text()).toContain('1 / 9'); // the card is still there

    // Drags past 110 points and releases: swiped, and no detail screen opens.
    mockRouter.push.mockClear();
    await drag(111);
    await settle();
    expect(app.text()).toContain('2 / 9');
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(await savedIds()).toEqual([newestFirst[0].id]);
    app.close();
  });

  it('a short drag neither swipes nor opens the article', async () => {
    const app = await launch();
    await drag(50);
    await settle();
    expect(app.text()).toContain('1 / 9');
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(await swipesStored()).toBeNull();
    app.close();
  });

  it('after a swipe, tapping opens the card that is now on top', async () => {
    const app = await launch();
    await drag(-200);
    await settle();
    await tap();
    await settle();
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/article/[id]',
      params: { id: newestFirst[1].id, from: 'feed' },
    });
    app.close();
  });

  it('opens the detail screen once for a quick double tap', async () => {
    const app = await launch();
    await tap();
    await tap();
    await settle();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    app.close();
  });
});

