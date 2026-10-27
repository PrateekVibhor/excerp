import { hasNewCoverage, type ListsStore } from '../../data/listsStore';
import { useListsSnapshot } from './useLists';

/** True when any of the reader's lists has coverage that went up since they last looked: the dot on the Skills list tab. */
export function useNewCoverage(store?: ListsStore | null): boolean {
  return hasNewCoverage(useListsSnapshot(store));
}
