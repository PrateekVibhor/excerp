import { useCallback, useEffect, useState } from 'react';
import type { ReaderEntry, SocialApi } from '../../data/socialApi';

export type ReadersStatus = 'loading' | 'ready' | 'needsVisibility' | 'unavailable';

/** The readers of an article who chose to be seen. `needsVisibility` means this reader has not turned on being seen themselves. */
export function useReaders(articleId: string, social: SocialApi | null) {
  const [status, setStatus] = useState<ReadersStatus>('loading');
  const [readers, setReaders] = useState<ReaderEntry[]>([]);
  const [count, setCount] = useState(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!social) return;
    let alive = true;
    setStatus('loading');
    social.readers(articleId).then((res) => {
      if (!alive) return;
      if (res.kind === 'ok') {
        setReaders(res.value.readers);
        setCount(res.value.count);
        setStatus('ready');
      } else if (res.kind === 'refused' && res.status === 403 && res.code === 'visibility_required') setStatus('needsVisibility');
      else setStatus('unavailable');
    });
    return () => {
      alive = false;
    };
  }, [social, articleId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { status, readers, count, reload };
}
