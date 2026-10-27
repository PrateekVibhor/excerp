import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceIdRepository, leaderboardApi, syncQueue, type DeviceIdRepository, type LeaderboardApi, type LeaderboardResponse, type SyncQueue } from '../../data';

export type LeaderboardStatus = 'loading' | 'ready' | 'error';

export interface LeaderboardSources {
  api: LeaderboardApi;
  device: DeviceIdRepository;
  sync: SyncQueue;
}

const defaults: LeaderboardSources = { api: leaderboardApi, device: deviceIdRepository, sync: syncQueue };

/**
 * The board and the reader's own place on it. Opening it also tries to send anything still waiting from this device,
 * in parallel with loading, so the board is not held up by a slow server; if that send gets something through, the
 * board is fetched again quietly so the reader's own verification is counted.
 */
export function useLeaderboard(sources: LeaderboardSources = defaults) {
  const [status, setStatus] = useState<LeaderboardStatus>('loading');
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const src = useRef(sources);
  src.current = sources;
  const latest = useRef(0);

  const load = useCallback(() => {
    const attempt = ++latest.current;
    const current = () => attempt === latest.current;
    setStatus('loading');
    const fetchBoard = async () => src.current.api.getLeaderboard(await src.current.device.get());

    // The send never rejects or throws, but loading the board must not depend on that.
    try {
      Promise.resolve(src.current.sync.flush())
        .then(async (result) => {
          if (!result || result.sent === 0 || !current()) return;
          try {
            const fresh = await fetchBoard();
            if (current()) setBoard(fresh);
          } catch {
            // The board already shown stays; the next open will catch up.
          }
        })
        .catch(() => {});
    } catch {
      // a queue that throws at once: the board still loads
    }

    fetchBoard().then(
      (data) => {
        if (!current()) return;
        setBoard(data);
        setStatus('ready');
      },
      (error) => {
        if (!current()) return;
        console.warn('Could not load the leaderboard', error);
        setStatus('error');
      },
    );
  }, []);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  return { status, board, retry: load };
}
