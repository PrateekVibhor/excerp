import { act, create } from 'react-test-renderer';
import type { Article, ArticleRepository } from '../../data';
import { createMockRepositories } from '../../data/mockRepository';
import { useArticle } from './useArticle';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

async function mount(id: string | undefined, repo: ArticleRepository) {
  const out = { current: undefined as never as ReturnType<typeof useArticle> };
  function Harness({ id: current }: { id: string | undefined }) {
    out.current = useArticle(current, repo);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness id={id} />);
  });
  await act(async () => {});
  return { out, renderer, Harness };
}

const repo = () => createMockRepositories().articles;

describe('useArticle', () => {
  it('loads an article by id', async () => {
    const { out } = await mount('mock-3', repo());
    expect(out.current.status).toBe('ready');
    expect(out.current.article?.id).toBe('mock-3');
  });

  it('reports notFound for an id the source does not have', async () => {
    const { out } = await mount('does-not-exist', repo());
    expect(out.current.status).toBe('notFound');
    expect(out.current.article).toBeNull();
  });

  it('reports notFound when there is no id at all', async () => {
    const { out } = await mount(undefined, repo());
    expect(out.current.status).toBe('notFound');
  });

  it('shows loading until the source answers', async () => {
    let answer!: (a: Article | undefined) => void;
    const slow: ArticleRepository = {
      getFeed: async () => [],
      getById: () => new Promise((resolve) => (answer = resolve)),
    };
    const { out } = await mount('mock-1', slow);
    expect(out.current.status).toBe('loading');
    const real = (await repo().getById('mock-1'))!;
    await act(async () => answer(real));
    expect(out.current.status).toBe('ready');
  });

  it('reports an error when the source fails, and Retry recovers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const flaky: ArticleRepository = {
      getFeed: async () => [],
      getById: async (id) => {
        if (fail) throw new Error('Network request failed');
        return repo().getById(id);
      },
    };
    const { out } = await mount('mock-1', flaky);
    expect(out.current.status).toBe('error');

    fail = false;
    await act(async () => out.current.retry());
    await act(async () => {});
    expect(out.current.status).toBe('ready');
    expect(out.current.article?.id).toBe('mock-1');
  });

  it('follows a change of id', async () => {
    const r = repo();
    const { out, renderer, Harness } = await mount('mock-1', r);
    expect(out.current.article?.id).toBe('mock-1');
    await act(async () => renderer.update(<Harness id="mock-2" />));
    await act(async () => {});
    expect(out.current.article?.id).toBe('mock-2');
  });
});
