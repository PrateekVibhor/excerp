import { useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

const LOCK_MS = 800;

/**
 * Opens the Article Detail screen for an article id. `from` tells the screen where the
 * user came from so its back button can say so. Repeated taps within a moment open the
 * screen once, so a double tap does not stack two copies.
 */
export function useOpenArticle(from: 'feed' | 'reading-list') {
  const router = useRouter();
  const locked = useRef(false);

  return useCallback(
    (articleId: string) => {
      if (locked.current) return;
      locked.current = true;
      setTimeout(() => {
        locked.current = false;
      }, LOCK_MS);
      router.push({ pathname: '/article/[id]', params: { id: articleId, from } });
    },
    [router, from],
  );
}
