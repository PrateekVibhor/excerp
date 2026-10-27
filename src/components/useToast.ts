import { useCallback, useEffect, useRef, useState } from 'react';
import { sheet } from '../theme';

/** A short message that clears itself. `show` replaces whatever is showing and restarts the timer. */
export function useToast(durationMs: number = sheet.toastShowMs) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback(
    (next: string) => {
      clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => setMessage(null), durationMs);
    },
    [durationMs],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  return { message, show };
}
