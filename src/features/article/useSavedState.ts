import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LOCAL_USER_ID,
  readingListRepository,
  subscribeToReadingList,
  type ReadingListRepository,
} from '../../data';

export interface SavedStateSource {
  readingList: ReadingListRepository;
  subscribe: (listener: () => void) => () => void;
  userId: string;
}

const defaults: SavedStateSource = {
  readingList: readingListRepository,
  subscribe: subscribeToReadingList,
  userId: LOCAL_USER_ID,
};

/**
 * Whether an article is in the user's Reading List, and a way to add it. Reads the same
 * device store as the list and the tab badge, so the three always agree.
 */
export function useSavedState(articleId: string | undefined, source: SavedStateSource = defaults) {
  const [saved, setSaved] = useState(false);
  const src = useRef(source);
  src.current = source;
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const attempt = ++latest.current;
    if (!articleId) {
      setSaved(false);
      return;
    }
    src.current.readingList
      .list(src.current.userId)
      .then((items) => {
        if (attempt === latest.current) setSaved(items.some((i) => i.article_id === articleId));
      })
      .catch((error) => console.warn('Could not read the saved state', error));
  }, [articleId]);

  useEffect(() => {
    refresh();
    const unsubscribe = src.current.subscribe(refresh);
    return () => {
      latest.current++;
      unsubscribe();
    };
  }, [refresh]);

  const save = useCallback(async () => {
    if (!articleId) return;
    setSaved(true); // show "Saved" at once; put it right if the write fails
    try {
      await src.current.readingList.add(src.current.userId, articleId);
    } catch (error) {
      console.error('Could not save the article', error);
      refresh();
    }
  }, [articleId, refresh]);

  return { saved, save };
}
