// Runs every Gherkin scenario in intent-5.md and spec-5.md against the real screens:
// Reading List, Article Detail, Feed and the tab bar, with the mock article source,
// the AsyncStorage mock for the device store, and a router that records navigation.
// To "follow" a navigation, the target screen is rendered with the arguments of the push.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComponentProps, ReactElement } from 'react';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { GlassTabBar } from '../components/GlassTabBar';
import { TabBadge } from '../components/TabBadge';
import { LOCAL_USER_ID, readingListRepository } from '../data';
import { createMockRepositories } from '../data/mockRepository';
import { ArticleDetailScreen } from './article/ArticleDetailScreen';
import { FeedScreen } from './feed/FeedScreen';
import { ReadingListScreen } from './readingList/ReadingListScreen';

const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  canGoBack: jest.fn(),
};
let mockParams: Record<string, string> = {};
const mockOpenBrowser = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: (...args: unknown[]) => mockOpenBrowser(...args) }));
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  Tabs: () => null,
}));

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};
const tabBarProps = {
  state: { index: 1, routes: [{ key: 'feed', name: 'feed' }, { key: 'reading-list', name: 'reading-list' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
} as unknown as ComponentProps<typeof GlassTabBar>;

let articles: Awaited<ReturnType<ReturnType<typeof createMockRepositories>['articles']['getFeed']>>;
let newestFirst: typeof articles;
const article = (id: string) => articles.find((a) => a.id === id)!;

beforeAll(async () => {
  articles = await createMockRepositories().articles.getFeed('x');
  newestFirst = [...articles].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
});

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  mockOpenBrowser.mockResolvedValue({ type: 'dismiss' });
  mockParams = {};
  await AsyncStorage.clear();
});
afterEach(() => jest.useRealTimers());

function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}

/** Renders a screen, optionally with the real tab bar beside it, and gives helpers to use it. */
async function mount(screen: ReactElement, withTabBar = false) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        {screen}
        {withTabBar && <GlassTabBar {...tabBarProps} />}
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  const find = (label: string) =>
    renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  return {
    renderer,
    text: () => texts(renderer.toJSON() as never),
    badge: () => renderer.root.findByType(TabBadge).props.count as number,
    press: async (label: string, index = 0) => {
      const target = find(label)[index];
      if (!target) throw new Error(`Nothing to press labelled "${label}"`);
      await act(async () => {
        target.props.onPress();
      });
      await act(async () => {});
    },
    hasControl: (label: string) => find(label).length > 0,
    close: () => act(() => renderer.unmount()),
  };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
};
const tapTopCard = () =>
  act(async () => {
    fireGestureHandler(getByGestureTestId('tap-card'), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
  });
const dragTopCard = (endX: number) =>
  act(async () => {
    fireGestureHandler(getByGestureTestId('swipe-card'), [
      { state: State.BEGAN },
      { state: State.ACTIVE, translationX: endX / 2, translationY: 0 },
      { translationX: endX, translationY: 0 },
      { state: State.END, translationX: endX, translationY: 0 },
    ]);
  });

/** Follows the last router.push by opening the article screen it asked for. */
async function followToDetail(withTabBar = false) {
  const call = mockRouter.push.mock.calls.at(-1)?.[0] as { pathname: string; params: Record<string, string> } | undefined;
  expect(call?.pathname).toBe('/article/[id]');
  mockParams = call!.params;
  return mount(<ArticleDetailScreen />, withTabBar);
}

const saveInOrder = async (...ids: string[]) => {
  for (const id of ids) await readingListRepository.add(LOCAL_USER_ID, id);
};
const savedIds = async () => (await readingListRepository.list(LOCAL_USER_ID)).map((i) => i.article_id);
const positions = (t: string[], titles: string[]) => titles.map((title) => t.indexOf(title));
const inOrder = (p: number[]) => p.every((v, i) => v >= 0 && (i === 0 || v > p[i - 1]));

describe('intent-5: Reading List and Article Detail', () => {
  it('Scenario: Saved articles are listed', async () => {
    await saveInOrder('mock-1', 'mock-2', 'mock-3'); // the user has saved three articles
    const list = await mount(<ReadingListScreen />); // opens the Reading List tab
    const t = list.text();
    expect(t).toContain('3 SAVED'); // three items are shown
    expect(inOrder(positions(t, [article('mock-3').title, article('mock-2').title, article('mock-1').title]))).toBe(true); // most recent first
  });

  it('Scenario: Empty state', async () => {
    const t = (await mount(<ReadingListScreen />)).text();
    expect(t).toContain('Nothing saved yet');
    expect(t).toContain('Swipe right on a card in Discover to save it here.');
  });

  it('Scenario: Remove an article', async () => {
    await saveInOrder('mock-1', 'mock-2', 'mock-3');
    const list = await mount(<ReadingListScreen />, true);
    expect(list.badge()).toBe(3);

    await list.press('Remove', 1); // removes the middle row, mock-2

    expect(list.text()).not.toContain(article('mock-2').title); // it disappears from the list
    expect(await savedIds()).toEqual(['mock-3', 'mock-1']);
    expect(list.badge()).toBe(2); // and the tab badge count decreases by one
  });

  it('Scenario: Open detail (from the Reading List)', async () => {
    await saveInOrder('mock-5');
    const list = await mount(<ReadingListScreen />);
    await list.press(`Open ${article('mock-5').title}`);
    const detail = await followToDetail();
    const t = detail.text();
    expect(t).toContain(article('mock-5').summary); // summary
    expect(t).toEqual(expect.arrayContaining(['McKinsey', 'mckinsey.com', 'Consulting', 'Sep 24'])); // source, tag, date
  });

  it('Scenario: Open detail (from the Feed)', async () => {
    const feed = await mount(<FeedScreen />);
    await tapTopCard();
    await settle();
    const top = newestFirst[0];
    const detail = await followToDetail();
    const t = detail.text();
    expect(t).toContain(top.summary);
    expect(t).toEqual(expect.arrayContaining([top.source_company, top.content_type, top.title, 'Oct 2']));
    feed.close();
  });

  it('Scenario: Open original', async () => {
    mockParams = { id: 'mock-6' };
    const detail = await mount(<ArticleDetailScreen />); // the Article Detail screen is open
    await detail.press('Open original');
    expect(mockOpenBrowser).toHaveBeenCalledTimes(1); // the source page opens in a browser
    expect(mockOpenBrowser).toHaveBeenCalledWith(article('mock-6').source_url);
  });

  it('Scenario: From the Reading List to the article, which shows no made-up readers', async () => {
    await saveInOrder('mock-2'); // the user has saved an article
    const list = await mount(<ReadingListScreen />);
    await list.press(`Open ${article('mock-2').title}`); // opens the Reading List tab and taps the article
    const detail = await followToDetail();

    // Article Detail opens with the summary. People who really read it are shown only when a server can say who they are, and
    // they chose to be seen: with sample data there is no "Also reading this" row, and none of the three fictional readers.
    const t = detail.text();
    expect(t).toContain(article('mock-2').summary);
    expect(t).not.toContain('ALSO READING THIS');
    for (const gone of ['Maya Chen', 'Daniel Okafor', 'Priya Raman']) expect(t).not.toContain(gone);
  });
});

describe('spec-5: Reading List and Article Detail (spec level)', () => {
  it('Scenario: Ordering', async () => {
    await saveInOrder('mock-1', 'mock-2'); // articles A then B were saved
    const t = (await mount(<ReadingListScreen />)).text();
    expect(inOrder(positions(t, [article('mock-2').title, article('mock-1').title]))).toBe(true); // B above A
  });

  it('Scenario: Tap versus drag', async () => {
    const feed = await mount(<FeedScreen />); // a card is on top of the Feed
    await tapTopCard(); // moves less than 10 points and releases
    await settle();
    expect(mockRouter.push).toHaveBeenCalledTimes(1); // the detail screen opens
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/article/[id]',
      params: { id: newestFirst[0].id, from: 'feed' },
    });

    mockRouter.push.mockClear();
    await dragTopCard(111); // drags past 110 points and releases
    await settle();
    expect(feed.text()).toContain('2 / 9'); // the card is swiped
    expect(mockRouter.push).not.toHaveBeenCalled(); // and no detail screen opens
    feed.close();
  });

  it('Scenario: Unknown article', async () => {
    mockParams = { id: 'does-not-exist' }; // the route opens with an id that does not exist
    const detail = await mount(<ArticleDetailScreen />);
    expect(detail.text()).toContain('Article not found'); // a "not found" message
    expect(detail.hasControl('Back')).toBe(true); // and a back control
    await detail.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Remove persists', async () => {
    await saveInOrder('mock-1', 'mock-2');
    const first = await mount(<ReadingListScreen />);
    await first.press('Remove', 1); // removes the older one, mock-1
    first.close(); // the app is closed

    const reopened = await mount(<ReadingListScreen />); // and reopened
    expect(reopened.text()).not.toContain(article('mock-1').title); // the article is still not in the list
    expect(reopened.text()).toContain(article('mock-2').title);
    expect(await savedIds()).toEqual(['mock-2']);
  });

  it('Scenario: Save from detail', async () => {
    mockParams = { id: 'mock-3' }; // detail is open for an article not in the list
    const detail = await mount(<ArticleDetailScreen />, true);
    expect(await savedIds()).toEqual([]);
    expect(detail.badge()).toBe(0);

    await detail.press('Save'); // the user taps Save

    expect(await savedIds()).toEqual(['mock-3']); // it appears in the Reading List
    expect(detail.badge()).toBe(1); // and the badge increases by one
    const list = await mount(<ReadingListScreen />);
    expect(list.text()).toContain(article('mock-3').title);
    expect(list.text()).toContain('1 SAVED');
  });
});
