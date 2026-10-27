import { useEffect } from 'react';
import { syncQueue, type SyncQueue } from '../../data';

/**
 * Sends any verifications left waiting from an earlier run, once, when the app starts. If the server cannot be
 * reached nothing happens: they stay queued for the next trigger. It never blocks or breaks the app.
 */
export function useSyncOnLaunch(queue: SyncQueue = syncQueue) {
  useEffect(() => {
    try {
      Promise.resolve(queue.flush()).catch(() => {}); // a failed send is just left waiting
    } catch {
      // a queue that throws instead of failing quietly must still not stop the app from starting
    }
    // once per launch, whatever re-renders follow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
