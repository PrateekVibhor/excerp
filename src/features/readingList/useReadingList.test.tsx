import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create } from 'react-test-renderer';
import { createRepositories } from '../../data';
import type { ArticleRepository, ReadingListRepository } from '../../data';
import { useSavedCount } from './useSavedCount';
import { useReadingList, type ReadingListSource } from './useReadingList';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER = 'user-1';

beforeEach(async () => {
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

function launch() {
  const r = createRepositories({ source: 'mock', apiUrl: undefined, storage: AsyncStorage });
  const source: ReadingListSource = {
    readingList: r.readingListRepository,
    articles: r.articleRepository,
    subscribe: r.subscribeToReadingList,
    userId: USER,
  };
  return { r, source };
}

async function mount(source: ReadingListSource) {
  const out = { list: undefined as never as ReturnType<typeof useReadingList>, badge: -1 };
  function Harness() {
    out.list = useReadingList(source);
    out.badge = useSavedCount({ readingList: source.readingList, subscribe: source.subscribe, userId: source.userId });
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {});
  return { out, renderer };
}

const ids = (out: { list: ReturnType<typeof useReadingList> }) => out.list.entries.map((e) => e.item.article_id);

describe('useReadingList', () => {
  it('is ready and empty when nothing has been saved', async () => {
    const { out } = await mount(launch().source);
    expect(out.list.status).toBe('ready');
    expect(out.list.entries).toEqual([]);
    expect(out.list.count).toBe(0);
  });

  it('lists saved articles newest save first, with the article attached', async () => {
    const { r, source } = launch();
    for (const id of ['mock-1', 'mock-2', 'mock-3']) await r.readingListRepository.add(USER, id);
    const { out } = await mount(source);

    expect(ids(out)).toEqual(['mock-3', 'mock-2', 'mock-1']);
    expect(out.list.entries[0].article?.id).toBe('mock-3');
    expect(out.list.entries[0].article?.title).toEqual(expect.any(String));
    expect(out.list.entries[0].item.saved_at).toEqual(expect.any(String));
    expect(out.list.count).toBe(3);
  });

  it('shows saved articles again after a restart', async () => {
    const first = launch();
    await first.r.readingListRepository.add(USER, 'mock-4');
    await first.r.readingListRepository.add(USER, 'mock-5');

    const { out } = await mount(launch().source); // a new launch over the same storage
    expect(ids(out)).toEqual(['mock-5', 'mock-4']);
  });

  it('follows a save made elsewhere, at the top, without a reload', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const { out } = await mount(source);

    await act(async () => void (await r.readingListRepository.add(USER, 'mock-2')));
    expect(ids(out)).toEqual(['mock-2', 'mock-1']);
  });

  it('removes an article from the list, the store and the badge together', async () => {
    const { r, source } = launch();
    for (const id of ['mock-1', 'mock-2', 'mock-3']) await r.readingListRepository.add(USER, id);
    const { out } = await mount(source);
    expect(out.badge).toBe(3);

    await act(async () => out.list.remove('mock-2'));
    await act(async () => {});

    expect(ids(out)).toEqual(['mock-3', 'mock-1']);
    expect((await r.readingListRepository.list(USER)).map((i) => i.article_id)).toEqual(['mock-3', 'mock-1']);
    expect(out.badge).toBe(2);
  });

  it('keeps a removal after a restart', async () => {
    const first = launch();
    await first.r.readingListRepository.add(USER, 'mock-1');
    await first.r.readingListRepository.add(USER, 'mock-2');
    const run1 = await mount(first.source);
    await act(async () => run1.out.list.remove('mock-1'));
    await act(async () => {});
    act(() => run1.renderer.unmount());

    const { out } = await mount(launch().source);
    expect(ids(out)).toEqual(['mock-2']);
  });

  it('puts the row back if removing fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const { out } = await mount(source);

    jest.spyOn(r.readingListRepository, 'remove').mockRejectedValueOnce(new Error('disk full'));
    await act(async () => out.list.remove('mock-1'));
    await act(async () => {});

    expect(ids(out)).toEqual(['mock-1']);
  });

  it('keeps an entry whose article the source does not have, and lets it be removed', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'ghost');
    await r.readingListRepository.add(USER, 'mock-1');
    const { out } = await mount(source);

    expect(ids(out)).toEqual(['mock-1', 'ghost']);
    expect(out.list.entries[1].article).toBeNull();

    await act(async () => out.list.remove('ghost'));
    await act(async () => {});
    expect(ids(out)).toEqual(['mock-1']);
  });

  it('keeps the list when one lookup fails, and tries that lookup again later', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    await r.readingListRepository.add(USER, 'mock-2');

    let failing = true;
    const flaky: ArticleRepository = {
      getFeed: r.articleRepository.getFeed,
      getById: async (id) => {
        if (id === 'mock-1' && failing) throw new Error('Network request failed');
        return r.articleRepository.getById(id);
      },
    };
    const { out } = await mount({ ...source, articles: flaky });
    expect(ids(out)).toEqual(['mock-2', 'mock-1']);
    expect(out.list.entries[0].article?.id).toBe('mock-2');
    expect(out.list.entries[1].article).toBeNull();

    failing = false;
    await act(async () => void (await r.readingListRepository.add(USER, 'mock-3'))); // triggers a reload
    expect(out.list.entries.find((e) => e.item.article_id === 'mock-1')?.article?.id).toBe('mock-1');
  });

  it('does not look an article up again once it has been loaded', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const getById = jest.spyOn(r.articleRepository, 'getById');
    const { out } = await mount(source);
    expect(getById).toHaveBeenCalledTimes(1);

    await act(async () => void (await r.readingListRepository.add(USER, 'mock-2')));
    expect(getById).toHaveBeenCalledTimes(2); // only the new one
    expect(ids(out)).toEqual(['mock-2', 'mock-1']);
  });

  it('shows the error state when the store cannot be read, and Retry recovers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    let broken = true;
    const flakyStore: ReadingListRepository = {
      ...r.readingListRepository,
      list: async (u) => {
        if (broken) throw new Error('storage unavailable');
        return r.readingListRepository.list(u);
      },
    };
    const { out } = await mount({ ...source, readingList: flakyStore });
    expect(out.list.status).toBe('error');

    broken = false;
    await act(async () => out.list.retry());
    await act(async () => {});
    expect(out.list.status).toBe('ready');
    expect(ids(out)).toEqual(['mock-1']);
  });

  it('unsubscribes when unmounted', async () => {
    const { source } = launch();
    const unsubscribe = jest.fn();
    const { renderer } = await mount({ ...source, subscribe: (l) => (source.subscribe(l), unsubscribe) });
    act(() => renderer.unmount());
    expect(unsubscribe).toHaveBeenCalled();
  });
});
