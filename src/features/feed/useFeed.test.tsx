import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create } from 'react-test-renderer';
import { createRepositories } from '../../data';
import type { Article, ArticleRepository } from '../../data';
import { createMockRepositories } from '../../data/mockRepository';
import { useFeed, type FeedRepositories } from './useFeed';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER = 'user-1';
let mockArticles: Article[];

beforeAll(async () => {
  mockArticles = await createMockRepositories().articles.getFeed(USER);
});
beforeEach(async () => {
  await AsyncStorage.clear();
});

function reposFrom(articles: ArticleRepository, readingList = createMockRepositories().readingList): FeedRepositories {
  return { articles, readingList, userId: USER };
}

async function setup(repos: FeedRepositories) {
  const result: { current: ReturnType<typeof useFeed> } = { current: undefined as never };
  function Harness() {
    result.current = useFeed(repos);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return { result, renderer };
}

const flush = () => act(async () => {});

describe('useFeed loading', () => {
  it('starts loading, then shows the feed newest first', async () => {
    let release!: (a: Article[]) => void;
    const articles: ArticleRepository = {
      getFeed: () => new Promise((resolve) => (release = resolve)),
      getById: async () => undefined,
    };
    const { result } = await setup(reposFrom(articles));
    expect(result.current.status).toBe('loading');

    await act(async () => release(mockArticles));
    expect(result.current.status).toBe('ready');
    const dates = result.current.articles.map((a) => Date.parse(a.published_at));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(result.current.index).toBe(0);
  });

  it('shows the error state when the feed cannot load, and Retry recovers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const articles: ArticleRepository = {
      getFeed: async () => {
        if (fail) throw new Error('Network request failed');
        return mockArticles;
      },
      getById: async () => undefined,
    };
    const { result } = await setup(reposFrom(articles));
    expect(result.current.status).toBe('error');
    expect(result.current.articles).toEqual([]);

    fail = false;
    await act(async () => result.current.retry());
    expect(result.current.status).toBe('ready');
    expect(result.current.total).toBe(mockArticles.length);
  });

  it('ignores a slow earlier load once a newer one has finished', async () => {
    const releases: Array<(a: Article[]) => void> = [];
    const articles: ArticleRepository = {
      getFeed: () => new Promise((resolve) => releases.push(resolve)),
      getById: async () => undefined,
    };
    const { result } = await setup(reposFrom(articles));
    await act(async () => result.current.retry());
    await act(async () => releases[1](mockArticles.slice(0, 2)));
    await act(async () => releases[0](mockArticles));
    expect(result.current.total).toBe(2);
  });

  it('treats an empty feed as all caught up', async () => {
    const articles: ArticleRepository = { getFeed: async () => [], getById: async () => undefined };
    const { result } = await setup(reposFrom(articles));
    expect(result.current.status).toBe('ready');
    expect(result.current.done).toBe(true);
  });
});

describe('useFeed swiping', () => {
  function seeded() {
    const mock = createMockRepositories();
    const recordSwipe = jest.spyOn(mock.readingList, 'recordSwipe');
    const add = jest.spyOn(mock.readingList, 'add');
    return { repos: reposFrom(mock.articles, mock.readingList), recordSwipe, add, mock };
  }

  it('a right swipe records the swipe, saves the article and advances', async () => {
    const { repos, recordSwipe, add } = seeded();
    const { result } = await setup(repos);
    const top = result.current.articles[0];

    await act(async () => result.current.swipe('right', top));

    expect(recordSwipe).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER, article_id: top.id, direction: 'right' }));
    expect(add).toHaveBeenCalledWith(USER, top.id);
    expect(result.current.index).toBe(1);
    expect(result.current.savedThisSession).toBe(1);
    expect(result.current.remaining).toBe(mockArticles.length - 1);
  });

  it('a left swipe records the swipe and saves nothing', async () => {
    const { repos, recordSwipe, add } = seeded();
    const { result } = await setup(repos);
    const top = result.current.articles[0];

    await act(async () => result.current.swipe('left', top));

    expect(recordSwipe).toHaveBeenCalledWith(expect.objectContaining({ article_id: top.id, direction: 'left' }));
    expect(add).not.toHaveBeenCalled();
    expect(result.current.index).toBe(1);
    expect(result.current.savedThisSession).toBe(0);
  });

  it('is all caught up after every card has been swiped', async () => {
    const { repos } = seeded();
    const { result } = await setup(repos);
    for (const [i, article] of result.current.articles.entries()) {
      await act(async () => result.current.swipe(i % 2 ? 'left' : 'right', article));
    }
    expect(result.current.done).toBe(true);
    expect(result.current.remaining).toBe(0);
    expect(result.current.savedThisSession).toBe(Math.ceil(mockArticles.length / 2));
  });

  it('does not crash if a write to the device fails', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { repos, recordSwipe } = seeded();
    recordSwipe.mockRejectedValueOnce(new Error('disk full'));
    const { result } = await setup(repos);

    await act(async () => result.current.swipe('left', result.current.articles[0]));
    await flush();

    expect(result.current.index).toBe(1);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('useFeed persistence across a restart', () => {
  const config = { source: 'mock', apiUrl: undefined, storage: AsyncStorage };
  const asFeedRepos = (r: ReturnType<typeof createRepositories>): FeedRepositories => ({
    articles: r.articleRepository,
    readingList: r.readingListRepository,
    userId: USER,
  });

  it('does not show swiped cards again, and keeps the saved one', async () => {
    const first = createRepositories(config);
    const run1 = await setup(asFeedRepos(first));
    const [a, b] = run1.result.current.articles;
    await act(async () => run1.result.current.swipe('right', a));
    await act(async () => run1.result.current.swipe('left', b));
    await flush();
    run1.renderer.unmount();

    const second = createRepositories(config);
    const run2 = await setup(asFeedRepos(second));
    const ids = run2.result.current.articles.map((x) => x.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).toHaveLength(mockArticles.length - 2);
    expect((await second.readingListRepository.list(USER)).map((i) => i.article_id)).toEqual([a.id]);
  });
});
