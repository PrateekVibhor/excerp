import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { verifiedRepository, type VerifiedRepository } from '../../data';
import { countByTopic, type VerifiedStats } from './countByTopic';

const EMPTY: VerifiedStats = { total: 0, byTopic: [] };

/** The reader's verified counts, recalculated from the device store each time the screen gains focus. An unreadable store gives the empty stats. */
export function useVerifiedStats(repository: Pick<VerifiedRepository, 'list'> = verifiedRepository): VerifiedStats {
  const [stats, setStats] = useState<VerifiedStats>(EMPTY);
  const latest = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const attempt = ++latest.current;
      repository
        .list()
        .then((records) => countByTopic(records), () => EMPTY)
        .then((next) => {
          if (attempt === latest.current) setStats(next); // only the newest read may set; a read that finishes after blur still lands harmlessly
        });
      return () => {
        latest.current++;
      };
    }, [repository]),
  );

  return stats;
}
