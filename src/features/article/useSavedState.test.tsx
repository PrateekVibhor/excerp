import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create } from 'react-test-renderer';
import { createRepositories } from '../../data';
import type { ReadingListRepository } from '../../data';
import { useSavedCount } from '../readingList/useSavedCount';
import { useSavedState, type SavedStateSource } from './useSavedState';

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
  const source: SavedStateSource = { readingList: r.readingListRepository, subscribe: r.subscribeToReadingList, userId: USER };
  return { r, source };
}

async function mount(articleId: string | undefined, source: SavedStateSource) {
  const out = { state: undefined as never as ReturnType<typeof useSavedState>, badge: -1 };
  function Harness({ id }: { id: string | undefined }) {
    out.state = useSavedState(id, source);
    out.badge = useSavedCount(source);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness id={articleId} />);
  });
  await act(async () => {});
  return { out, renderer, Harness };
}

describe('useSavedState', () => {
  it('is not saved when the article is not in the list', async () => {
    const { out } = await mount('mock-1', launch().source);
    expect(out.state.saved).toBe(false);
  });

  it('is saved when the article is already in the list', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const { out } = await mount('mock-1', source);
    expect(out.state.saved).toBe(true);
  });

  it('is not saved just because a different article is', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-2');
    const { out } = await mount('mock-1', source);
    expect(out.state.saved).toBe(false);
  });

  it('save adds it to the list, and the badge goes up by one', async () => {
    const { r, source } = launch();
    const { out } = await mount('mock-1', source);
    expect(out.badge).toBe(0);

    await act(async () => out.state.save());
    await act(async () => {});

    expect(out.state.saved).toBe(true);
    expect((await r.readingListRepository.list(USER)).map((i) => i.article_id)).toEqual(['mock-1']);
    expect(out.badge).toBe(1);
  });

  it('saving twice does not add it twice', async () => {
    const { r, source } = launch();
    const { out } = await mount('mock-1', source);
    await act(async () => {
      out.state.save();
      out.state.save();
    });
    await act(async () => {});
    expect(await r.readingListRepository.list(USER)).toHaveLength(1);
    expect(out.badge).toBe(1);
  });

  it('follows the article being removed from the list elsewhere', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const { out } = await mount('mock-1', source);
    expect(out.state.saved).toBe(true);

    await act(async () => r.readingListRepository.remove(USER, 'mock-1'));
    expect(out.state.saved).toBe(false);
  });

  it('follows the article being saved elsewhere', async () => {
    const { r, source } = launch();
    const { out } = await mount('mock-1', source);
    await act(async () => void (await r.readingListRepository.add(USER, 'mock-1')));
    expect(out.state.saved).toBe(true);
  });

  it('goes back to not saved if the write fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { r, source } = launch();
    const failing: ReadingListRepository = { ...r.readingListRepository, add: async () => { throw new Error('disk full'); } };
    const { out } = await mount('mock-1', { ...source, readingList: failing });
    await act(async () => out.state.save());
    await act(async () => {});
    expect(out.state.saved).toBe(false);
  });

  it('follows a change of article', async () => {
    const { r, source } = launch();
    await r.readingListRepository.add(USER, 'mock-1');
    const { out, renderer, Harness } = await mount('mock-1', source);
    expect(out.state.saved).toBe(true);
    await act(async () => renderer.update(<Harness id="mock-2" />));
    await act(async () => {});
    expect(out.state.saved).toBe(false);
  });

  it('is never saved without an article id', async () => {
    const { out } = await mount(undefined, launch().source);
    expect(out.state.saved).toBe(false);
    await act(async () => out.state.save());
    expect(out.state.saved).toBe(false);
  });
});
