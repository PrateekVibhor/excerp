import AsyncStorage from '@react-native-async-storage/async-storage';
import { ScrollView, StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';
import { bottomClear } from '../../theme';
import type { ComponentProps } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GlassTabBar } from '../../components/GlassTabBar';
import { TabBadge } from '../../components/TabBadge';
import { LOCAL_USER_ID, readingListRepository } from '../../data';
import { createMockRepositories } from '../../data/mockRepository';
import { ReadingListScreen } from './ReadingListScreen';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}

const tabBarProps = {
  state: { index: 1, routes: [{ key: 'feed', name: 'feed' }, { key: 'reading-list', name: 'reading-list' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
} as unknown as ComponentProps<typeof GlassTabBar>;

async function show() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <ReadingListScreen />
        <GlassTabBar {...tabBarProps} />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  return { renderer, text: () => texts(renderer.toJSON() as never) };
}

const titleOf = async (id: string) => (await createMockRepositories().articles.getById(id))!.title;

describe('ReadingListScreen', () => {
  it('shows the empty state when nothing is saved', async () => {
    const t = (await show()).text();
    expect(t).toContain('Nothing saved yet');
    expect(t).toContain('Swipe right on a card in Discover to save it here.');
    expect(t).toContain('0 SAVED');
  });

  it('lists the saved articles, newest save first, with the count', async () => {
    for (const id of ['mock-1', 'mock-2', 'mock-3']) await readingListRepository.add(LOCAL_USER_ID, id);
    const t = (await show()).text();

    expect(t).toContain('3 SAVED');
    const order = await Promise.all(['mock-3', 'mock-2', 'mock-1'].map(titleOf));
    const positions = order.map((title) => t.indexOf(title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions); // mock-3 first
    expect(t).not.toContain('Nothing saved yet');
  });

  it('shows each row with company, content type, a saved date and a Remove button', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-4'); // OpenAI, Release
    const t = (await show()).text();
    expect(t).toEqual(expect.arrayContaining(['OpenAI', 'Release', 'Remove']));
    expect(t.some((s) => /^Saved [A-Z][a-z]{2} \d{1,2}$/.test(s))).toBe(true);
  });

  it('keeps an article the source no longer has, marked unavailable', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'ghost');
    const t = (await show()).text();
    expect(t).toContain('Article unavailable');
    expect(t).toContain('Remove');
    expect(t).toContain('1 SAVED');
  });
});

describe('Remove', () => {
  const removeButtons = (r: ReturnType<typeof create>) =>
    r.root.findAll(
      (n: ReactTestInstance) => n.props.accessibilityLabel === 'Remove' && typeof n.props.onPress === 'function',
    );
  const savedIds = async () => (await readingListRepository.list(LOCAL_USER_ID)).map((i) => i.article_id);

  it('takes the row out of the list, the store and the badge together', async () => {
    for (const id of ['mock-1', 'mock-2', 'mock-3']) await readingListRepository.add(LOCAL_USER_ID, id);
    const app = await show();
    expect(app.renderer.root.findByType(TabBadge).props.count).toBe(3);

    // Rows are newest first: mock-3, mock-2, mock-1. Remove the middle one.
    await act(async () => removeButtons(app.renderer)[1].props.onPress());
    await act(async () => {});

    const t = app.text();
    expect(t).toContain('2 SAVED');
    expect(t).not.toContain(await titleOf('mock-2'));
    expect(t).toContain(await titleOf('mock-3'));
    expect(t).toContain(await titleOf('mock-1'));
    expect(await savedIds()).toEqual(['mock-3', 'mock-1']);
    expect(app.renderer.root.findByType(TabBadge).props.count).toBe(2);
  });

  it('shows the empty state and hides the badge after the last article is removed', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    const app = await show();
    await act(async () => removeButtons(app.renderer)[0].props.onPress());
    await act(async () => {});

    expect(app.text()).toContain('Nothing saved yet');
    expect(app.text()).toContain('0 SAVED');
    expect(app.renderer.root.findByType(TabBadge).props.count).toBe(0);
    expect(await savedIds()).toEqual([]);
  });

  it('removes an unavailable article too', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'ghost');
    const app = await show();
    await act(async () => removeButtons(app.renderer)[0].props.onPress());
    await act(async () => {});
    expect(app.text()).toContain('Nothing saved yet');
  });

  it('a second press on the same row does nothing extra', async () => {
    for (const id of ['mock-1', 'mock-2']) await readingListRepository.add(LOCAL_USER_ID, id);
    const app = await show();
    const button = removeButtons(app.renderer)[0]; // mock-2
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    await act(async () => {});
    expect(await savedIds()).toEqual(['mock-1']);
    expect(app.renderer.root.findByType(TabBadge).props.count).toBe(1);
  });

  it('does not bring the article back to the Feed (it stays swiped)', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    await readingListRepository.recordSwipe({
      user_id: LOCAL_USER_ID,
      article_id: 'mock-1',
      direction: 'right',
      swiped_at: '2026-10-04T00:00:00Z',
    });
    const app = await show();
    await act(async () => removeButtons(app.renderer)[0].props.onPress());
    await act(async () => {});
    const { articleRepository } = require('../../data') as typeof import('../../data');
    const feed = await articleRepository.getFeed(LOCAL_USER_ID);
    expect(feed.map((a) => a.id)).not.toContain('mock-1');
  });
});

describe('Opening an article from the list', () => {
  const press = async (app: { renderer: ReturnType<typeof create> }, label: string) => {
    const target = app.renderer.root.findAll(
      (n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
    )[0];
    await act(async () => {
      target.props.onPress();
    });
  };

  it('tapping a row opens that article, remembering it came from the Reading List', async () => {
    for (const id of ['mock-1', 'mock-2']) await readingListRepository.add(LOCAL_USER_ID, id);
    const app = await show();
    await press(app, `Open ${await titleOf('mock-1')}`);
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/article/[id]',
      params: { id: 'mock-1', from: 'reading-list' },
    });
  });

  it('pressing Remove removes the article and does not open it', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    const app = await show();
    await press(app, 'Remove');
    await act(async () => {});
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(app.text()).toContain('Nothing saved yet');
  });

  it('an unavailable article cannot be opened', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'ghost');
    const app = await show();
    const rows = app.renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Article unavailable');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((n: ReactTestInstance) => typeof n.props.onPress !== 'function')).toBe(true);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('ReadingListScreen and the floating tab bar', () => {
  it('leaves the shared room under the tab bar below the last row, so it can scroll fully clear of the bar', async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<SafeAreaProvider initialMetrics={metrics}><ReadingListScreen /></SafeAreaProvider>);
    });
    await act(async () => {});
    const scroll = r.root.findAllByType(ScrollView)[0];
    expect(scroll).toBeDefined();
    expect(StyleSheet.flatten(scroll!.props.contentContainerStyle).paddingBottom).toBe(34 + bottomClear);
  });
});
