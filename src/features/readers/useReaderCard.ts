import { useCallback, useEffect, useState } from 'react';
import type { ReaderCard, SocialApi } from '../../data/socialApi';

export type CardStatus = 'loading' | 'ready' | 'notFound' | 'needsVisibility' | 'unavailable';

/** One reader's card by public id. `notFound` covers every reason it cannot be shown, as the server does. */
export function useReaderCard(publicId: string | undefined, social: SocialApi | null) {
  const [status, setStatus] = useState<CardStatus>('loading');
  const [card, setCard] = useState<ReaderCard | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!social) return;
    if (!publicId) {
      setStatus('notFound');
      return;
    }
    let alive = true;
    setStatus('loading');
    social.card(publicId).then((res) => {
      if (!alive) return;
      if (res.kind === 'ok') {
        setCard(res.value);
        setStatus('ready');
      } else if (res.kind === 'refused' && res.status === 404) setStatus('notFound');
      else if (res.kind === 'refused' && res.status === 403 && res.code === 'visibility_required') setStatus('needsVisibility');
      else setStatus('unavailable');
    });
    return () => {
      alive = false;
    };
  }, [social, publicId, nonce]);

  return { status, card, reload: useCallback(() => setNonce((n) => n + 1), []) };
}
