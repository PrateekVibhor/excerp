import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GlassTabBar } from '../../components/GlassTabBar';
import { TabBadge } from '../../components/TabBadge';
import { articleRepository, LOCAL_USER_ID, readingListRepository, verifiedRepository } from '../../data';
import { ReadingListScreen } from '../readingList/ReadingListScreen';
import type { ComponentProps } from 'react';
import { createMockRepositories } from '../../data/mockRepository';
import { ArticleDetailScreen } from './ArticleDetailScreen';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockOpenBrowser = jest.fn();
jest.mock('expo-web-browser', () => ({ openBrowserAsync: (...args: unknown[]) => mockOpenBrowser(...args) }));

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
let mockParams: { id?: string; from?: string } = {};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockOpenBrowser.mockResolvedValue({ type: 'dismiss' });
  mockRouter.canGoBack.mockReturnValue(true);
});

function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}

async function open(params: typeof mockParams) {
  mockParams = params;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <ArticleDetailScreen />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  return {
    renderer,
    text: () => texts(renderer.toJSON() as never),
    press: async (label: string) => {
      const target = renderer.root.findAll(
        (n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
      )[0];
      // Like a real press, ignore whatever the handler returns instead of waiting on it.
      await act(async () => {
        target.props.onPress();
      });
    },
  };
}

describe('ArticleDetailScreen', () => {
  it('shows the summary, source, tag and date for the article in the route', async () => {
    const a = (await createMockRepositories().articles.getById('mock-9'))!; // Y Combinator, Venture Capital, Sep 22
    const t = (await open({ id: 'mock-9' })).text();
    expect(t).toEqual(expect.arrayContaining([a.source_company, a.content_type, a.title, a.summary, 'SUMMARY']));
    expect(t).toContain('ycombinator.com');
    expect(t).toContain('Sep 22');
    expect(t).toContain(`${a.reader_count} reading`);
    expect(t).toContain('Open original');
    expect(t).toContain('Opens on ycombinator.com');
  });

  it('shows the full summary, not a shortened one', async () => {
    const a = (await createMockRepositories().articles.getById('mock-4'))!;
    const t = (await open({ id: 'mock-4' })).text();
    expect(t).toContain(a.summary);
    expect(a.summary.split(/\s+/).length).toBeGreaterThanOrEqual(50);
  });

  it('shows a not-found message with a back control for an unknown id', async () => {
    const screen = await open({ id: 'does-not-exist' });
    const t = screen.text();
    expect(t).toContain('Article not found');
    expect(t).toContain('Back');
    expect(t).not.toContain('Open original');
    await screen.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('shows not found when the route has no id', async () => {
    expect((await open({})).text()).toContain('Article not found');
  });

  it('goes back to the previous screen', async () => {
    const screen = await open({ id: 'mock-1', from: 'reading-list' });
    await screen.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('falls back to the Feed when there is nothing to go back to', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const screen = await open({ id: 'mock-1' });
    await screen.press('Back');
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/feed');
  });

  it('labels the back control after where the user came from', async () => {
    expect((await open({ id: 'mock-1', from: 'reading-list' })).text()).toContain('Reading List');
    expect((await open({ id: 'mock-1', from: 'feed' })).text()).toContain('Discover');
    expect((await open({ id: 'mock-1' })).text()).toContain('Back');
  });

  describe('Also reading this', () => {
    it('Scenario: no made-up readers - with no server to ask (sample data) there is no "Also reading" section at all', async () => {
      const t = (await open({ id: 'mock-2' })).text();
      expect(t).not.toContain('ALSO READING THIS');
      for (const gone of ['Maya Chen', 'Daniel Okafor', 'Priya Raman']) expect(t).not.toContain(gone);
    });

    it('makes no network request', async () => {
      const fetchSpy = jest.fn();
      (global as { fetch: unknown }).fetch = fetchSpy;
      await open({ id: 'mock-2' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is not shown when the article is not found', async () => {
      expect((await open({ id: 'nope' })).text()).not.toContain('ALSO READING THIS');
    });
  });

  describe('How many are reading', () => {
    it('says "N reading" only when N is a real count above zero, and nothing when it is 0', async () => {
      const a = (await articleRepository.getById('mock-1'))!;
      const original = articleRepository.getById;
      try {
        (articleRepository as { getById: unknown }).getById = async () => ({ ...a, reader_count: 0 });
        expect((await open({ id: 'mock-1' })).text()).not.toContain('reading');
        (articleRepository as { getById: unknown }).getById = async () => ({ ...a, reader_count: 7 });
        expect((await open({ id: 'mock-1' })).text()).toContain('7 reading');
      } finally {
        (articleRepository as { getById: unknown }).getById = original;
      }
    });
  });
});
