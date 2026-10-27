import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create } from 'react-test-renderer';
import { createRepositories } from '../../data';
import { useFeed } from '../feed/useFeed';
import { useSavedCount, type SavedCountSource } from './useSavedCount';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER = 'user-1';

beforeEach(async () => {
  await AsyncStorage.clear();
});

function repositories() {
  const r = createRepositories({ source: 'mock', apiUrl: undefined, storage: AsyncStorage });
  const source: SavedCountSource = {
    readingList: r.readingListRepository,
    subscribe: r.subscribeToReadingList,
    userId: USER,
  };
  return { r, source };
}

async function mountCount(source: SavedCountSource) {
  const result = { current: -1 };
  function Harness() {
    result.current = useSavedCount(source);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return { result, renderer };
}

describe('useSavedCount', () => {
  it('is zero when nothing has been saved', async () => {
    const { source } = repositories();
    const { result } = await mountCount(source);
    expect(result.current).toBe(0);
  });

  it('starts at the number of items already saved', async () => {
    const { r, source } = repositories();
    await r.readingListRepository.add(USER, 'a');
    await r.readingListRepository.add(USER, 'b');
    const { result } = await mountCount(source);
    expect(result.current).toBe(2);
  });

  it('follows adds and removes and always matches the list', async () => {
    const { r, source } = repositories();
    const { result } = await mountCount(source);

    for (const id of ['a', 'b', 'c']) await act(async () => void (await r.readingListRepository.add(USER, id)));
    expect(result.current).toBe(3);

    await act(async () => r.readingListRepository.remove(USER, 'b'));
    expect(result.current).toBe(2);
    expect(result.current).toBe((await r.readingListRepository.list(USER)).length);
  });

  it('does not double count a duplicate add', async () => {
    const { r, source } = repositories();
    const { result } = await mountCount(source);
    await act(async () => void (await r.readingListRepository.add(USER, 'a')));
    await act(async () => void (await r.readingListRepository.add(USER, 'a')));
    expect(result.current).toBe(1);
  });

  it('unsubscribes when unmounted', async () => {
    const { source } = repositories();
    const unsubscribe = jest.fn();
    const { renderer } = await mountCount({ ...source, subscribe: (l) => (source.subscribe(l), unsubscribe) });
    act(() => renderer.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('goes up by one when the Feed saves a card with a right swipe', async () => {
    const { r, source } = repositories();
    const { result } = await mountCount(source);

    const feed = { current: undefined as never as ReturnType<typeof useFeed> };
    function FeedHarness() {
      feed.current = useFeed({ articles: r.articleRepository, readingList: r.readingListRepository, userId: USER });
      return null;
    }
    await act(async () => void create(<FeedHarness />));

    await act(async () => feed.current.swipe('left', feed.current.articles[0]));
    expect(result.current).toBe(0); // skipping does not save

    await act(async () => feed.current.swipe('right', feed.current.articles[1]));
    expect(result.current).toBe(1);
    await act(async () => feed.current.swipe('right', feed.current.articles[2]));
    expect(result.current).toBe(2);
  });
});
