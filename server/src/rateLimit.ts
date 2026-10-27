export interface RateLimiter {
  /** Counts one request for `key`. False means the key has used up its allowance in the current window. */
  take(key: string): boolean;
}

/**
 * At most `max` requests per key in any rolling `windowMs`. Kept in memory, so a restart of the API clears it:
 * good enough for one server, and it cannot be fooled by waiting for a calendar hour to turn over.
 */
export function createRateLimiter({ max, windowMs, now = Date.now }: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const seen = new Map<string, number[]>();
  let calls = 0;
  return {
    take(key) {
      const t = now();
      // Every so often forget keys whose requests have all aged out, so random keys cannot fill the memory.
      if (++calls % 1000 === 0) {
        for (const [k, times] of seen) if (times[times.length - 1] <= t - windowMs) seen.delete(k);
      }
      const recent = (seen.get(key) ?? []).filter((time) => time > t - windowMs);
      if (recent.length >= max) {
        seen.set(key, recent);
        return false;
      }
      recent.push(t);
      seen.set(key, recent);
      return true;
    },
  };
}
