import { useEffect, useState } from 'react';
import {
  LOCAL_USER_ID,
  readingListRepository,
  subscribeToReadingList,
  type ReadingListRepository,
} from '../../data';

export interface SavedCountSource {
  readingList: ReadingListRepository;
  subscribe: (listener: () => void) => () => void;
  userId: string;
}

const defaults: SavedCountSource = {
  readingList: readingListRepository,
  subscribe: subscribeToReadingList,
  userId: LOCAL_USER_ID,
};

/** Number of saved articles, kept current as items are added or removed. */
export function useSavedCount({ readingList, subscribe, userId }: SavedCountSource = defaults): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    let latest = 0;
    const refresh = () => {
      const id = ++latest;
      readingList
        .list(userId)
        .then((items) => {
          // Only the most recent refresh may set the count.
          if (active && id === latest) setCount(items.length);
        })
        .catch((error) => console.warn('Could not read the saved count', error));
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [readingList, subscribe, userId]);

  return count;
}
