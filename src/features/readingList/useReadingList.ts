import { useCallback, useEffect, useRef, useState } from 'react';
import {
  articleRepository,
  LOCAL_USER_ID,
  readingListRepository,
  subscribeToReadingList,
  type Article,
  type ArticleRepository,
  type ReadingListItem,
  type ReadingListRepository,
} from '../../data';

export interface ReadingListEntry {
  item: ReadingListItem;
  /** Null when the article source cannot supply it; the entry can still be removed. */
  article: Article | null;
}

export interface ReadingListSource {
  readingList: ReadingListRepository;
  articles: ArticleRepository;
  subscribe: (listener: () => void) => () => void;
  userId: string;
}

const defaults: ReadingListSource = {
  readingList: readingListRepository,
  articles: articleRepository,
  subscribe: subscribeToReadingList,
  userId: LOCAL_USER_ID,
};

export type ReadingListStatus = 'loading' | 'ready' | 'error';

/**
 * The user's saved articles, newest save first. Reads the device store, looks each
 * article up through the article source, and follows saves and removals as they happen.
 */
export function useReadingList(source: ReadingListSource = defaults) {
  const [status, setStatus] = useState<ReadingListStatus>('loading');
  const [entries, setEntries] = useState<ReadingListEntry[]>([]);

  const src = useRef(source);
  src.current = source;
  // Articles already looked up (null = the source does not have it), so a new save
  // does not refetch every other row. A failed lookup is not cached and is retried.
  const articleCache = useRef(new Map<string, Article | null>());
  // Only the most recent load may update state.
  const latestLoad = useRef(0);

  const load = useCallback(async (showLoading: boolean) => {
    const id = ++latestLoad.current;
    if (showLoading) setStatus('loading');
    try {
      const { readingList, articles, userId } = src.current;
      const items = await readingList.list(userId);
      await Promise.all(
        items
          .filter((i) => !articleCache.current.has(i.article_id))
          .map(async (i) => {
            try {
              articleCache.current.set(i.article_id, (await articles.getById(i.article_id)) ?? null);
            } catch (error) {
              console.warn('Could not look up a saved article', i.article_id, error);
            }
          }),
      );
      if (id !== latestLoad.current) return;
      setEntries(items.map((item) => ({ item, article: articleCache.current.get(item.article_id) ?? null })));
      setStatus('ready');
    } catch (error) {
      if (id !== latestLoad.current) return;
      console.warn('Could not load the reading list', error);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load(true);
    const unsubscribe = src.current.subscribe(() => load(false));
    return () => {
      latestLoad.current++;
      unsubscribe();
    };
  }, [load]);

  const remove = useCallback(
    async (articleId: string) => {
      // Take the row out at once; put things right if the write fails.
      setEntries((prev) => prev.filter((e) => e.item.article_id !== articleId));
      try {
        await src.current.readingList.remove(src.current.userId, articleId);
      } catch (error) {
        console.error('Could not remove the article', error);
        load(false);
      }
    },
    [load],
  );

  return { status, entries, count: entries.length, remove, retry: () => load(true) };
}
