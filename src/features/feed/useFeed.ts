import { useCallback, useEffect, useRef, useState } from 'react';
import {
  articleRepository,
  LOCAL_USER_ID,
  readingListRepository,
  type Article,
  type ArticleRepository,
  type ReadingListRepository,
  type SwipeDirection,
} from '../../data';

export type FeedStatus = 'loading' | 'error' | 'ready';

export interface FeedRepositories {
  articles: ArticleRepository;
  readingList: ReadingListRepository;
  userId: string;
}

const defaults: FeedRepositories = {
  articles: articleRepository,
  readingList: readingListRepository,
  userId: LOCAL_USER_ID,
};

const newestFirst = (feed: Article[]) =>
  [...feed].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

/** Loads the feed, tracks the top card, and records each swipe on the device. */
export function useFeed(repositories: FeedRepositories = defaults) {
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [articles, setArticles] = useState<Article[]>([]);
  const [index, setIndex] = useState(0);
  const [savedThisSession, setSavedThisSession] = useState(0);

  const repos = useRef(repositories);
  repos.current = repositories;
  // Only the most recent load may update state, so a slow earlier attempt cannot overwrite it.
  const latestLoad = useRef(0);

  const load = useCallback(() => {
    const id = ++latestLoad.current;
    setStatus('loading');
    repos.current.articles
      .getFeed(repos.current.userId)
      .then((feed) => {
        if (id !== latestLoad.current) return;
        setArticles(newestFirst(feed));
        setIndex(0);
        setStatus('ready');
      })
      .catch((error) => {
        if (id !== latestLoad.current) return;
        console.warn('Could not load the feed', error);
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    load();
    return () => {
      latestLoad.current++;
    };
  }, [load]);

  const swipe = useCallback((direction: SwipeDirection, article: Article) => {
    // Advance at once; the writes land on the device in the background.
    setIndex((i) => i + 1);
    if (direction === 'right') setSavedThisSession((n) => n + 1);

    const { readingList, userId } = repos.current;
    const writes = [
      readingList.recordSwipe({
        user_id: userId,
        article_id: article.id,
        direction,
        swiped_at: new Date().toISOString(),
      }),
    ];
    if (direction === 'right') writes.push(readingList.add(userId, article.id).then(() => undefined));
    Promise.all(writes).catch((error) => console.error('Could not save your swipe', error));
  }, []);

  const total = articles.length;
  return {
    status,
    articles,
    index,
    total,
    remaining: Math.max(total - index, 0),
    done: status === 'ready' && index >= total,
    savedThisSession,
    swipe,
    retry: load,
  };
}
