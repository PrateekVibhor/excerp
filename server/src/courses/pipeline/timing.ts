// Measurement only: how long each stage of a run takes, and how many calls to the model, search, page fetches and so on it makes, how long they take in all,
// and how many were in flight at once. It changes nothing about what is called or returned.
type Fn = (...args: never[]) => unknown;
export interface CallStats { calls: number; totalMs: number; maxMs: number; maxParallel: number }
export interface TimingReport {
  totalMs: number;
  stages: Array<{ stage: string; ms: number; calls: Record<string, { calls: number; totalMs: number }> }>;
  calls: Record<string, CallStats>;
}

export function createTimer(now: () => number = () => performance.now()) {
  const started = now();
  const stages: TimingReport['stages'] = [];
  const calls: Record<string, CallStats> = {};
  const inflight: Record<string, number> = {};
  let open: { stage: string; at: number; calls: Record<string, { calls: number; totalMs: number }> } | undefined;
  const close = () => {
    if (open) stages.push({ stage: open.stage, ms: Math.round(now() - open.at), calls: open.calls });
    open = undefined;
  };

  function wrap<F extends Fn>(label: string, fn: F): F {
    return (async (...args: never[]) => {
      const at = now();
      const stats = (calls[label] ??= { calls: 0, totalMs: 0, maxMs: 0, maxParallel: 0 });
      const mine = open; // the stage the call began in
      inflight[label] = (inflight[label] ?? 0) + 1;
      stats.maxParallel = Math.max(stats.maxParallel, inflight[label]!);
      try {
        return await fn(...args);
      } finally {
        const ms = Math.round(now() - at);
        inflight[label]!--;
        stats.calls++;
        stats.totalMs += ms;
        stats.maxMs = Math.max(stats.maxMs, ms);
        if (mine) {
          const s = (mine.calls[label] ??= { calls: 0, totalMs: 0 });
          s.calls++;
          s.totalMs += ms;
        }
      }
    }) as unknown as F;
  }

  return {
    wrap,
    /** An object of functions, each timed as `label.method`. */
    wrapAll<T extends object>(label: string, obj: T): T {
      const out = { ...obj } as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'function') out[k] = wrap(`${label}.${k}`, (v as Fn).bind(obj) as Fn);
      return out as T;
    },
    /** A new stage begins; the one before it ends. */
    stage(name: string) {
      close();
      open = { stage: name, at: now(), calls: {} };
    },
    end: close,
    report(): TimingReport {
      return { totalMs: Math.round(now() - started), stages, calls };
    },
  };
}
