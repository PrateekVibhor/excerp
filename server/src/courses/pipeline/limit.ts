// Runs `fn` over the items with at most `limit` in flight. Results are in the order of the items. After a failure nothing new starts, the calls already
// running are waited for (so none is left writing after the caller has moved on), and the first error is thrown.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failed.error;
  return out;
}
