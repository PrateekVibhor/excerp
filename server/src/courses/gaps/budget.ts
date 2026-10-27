// Source finder: spending limits, checked before every search. A gap has its own limit, a batch has one, and the ledger has the last word.
export class GapLimit extends Error {}
export class BatchLimit extends Error {}

export interface Ledger {
  charge(credits: number, label: string): void;
}
export function createBudget(opts: { perGap: number; batch: number; ledger: Ledger }) {
  const byGap = new Map<string, number>();
  let batch = 0;
  return {
    /** One credit, for one search. Throws GapLimit or BatchLimit without charging; the ledger's own refusal passes through unchanged. */
    spend(gap: string, label: string): void {
      if ((byGap.get(gap) ?? 0) + 1 > opts.perGap) throw new GapLimit(`${gap}: the limit of ${opts.perGap} credits for one gap is used`);
      if (batch + 1 > opts.batch) throw new BatchLimit(`the limit of ${opts.batch} credits for this batch is used`);
      opts.ledger.charge(1, label);
      byGap.set(gap, (byGap.get(gap) ?? 0) + 1);
      batch += 1;
    },
    spentOn: (gap: string) => byGap.get(gap) ?? 0,
    spentInBatch: () => batch,
    remainingInBatch: () => opts.batch - batch,
  };
}
export type Budget = ReturnType<typeof createBudget>;
