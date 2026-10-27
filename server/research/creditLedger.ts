import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Thrown, before a call is made, when the call would pass the phase's limit. */
export class CapReached extends Error {}

interface Entry {
  at: string;
  label: string;
  credits: number;
}
interface PhaseRecord {
  partial: boolean;
  entries: Entry[];
}
type File = Record<string, PhaseRecord>;

export interface LedgerOptions {
  /** 'R0', 'R1' or 'R2': each phase has its own cap and never borrows from another. */
  phase: string;
  cap: number;
  /** Kept free under the cap: the limit is cap minus reserve. */
  reserve?: number;
}

/**
 * A running count of Tavily credits for one research phase, kept in a file so it carries over between
 * runs. Call charge() before each paid call; it throws CapReached, and records nothing, if the call
 * would pass the limit. Spec 16 section 3.1.
 */
export function openLedger(file: string, { phase, cap, reserve = 0 }: LedgerOptions) {
  const limit = cap - reserve;
  const load = (): File => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as File) : {});
  const record = (all: File): PhaseRecord => (all[phase] ??= { partial: false, entries: [] });
  const total = (r: PhaseRecord) => r.entries.reduce((sum, e) => sum + e.credits, 0);
  const save = (all: File) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  };

  return {
    spent: () => total(record(load())),
    charge(credits: number, label: string) {
      if (!Number.isInteger(credits) || credits < 1) throw new RangeError(`a charge must be a whole number of credits, got ${credits}`);
      const all = load();
      const r = record(all);
      if (total(r) + credits > limit) {
        r.partial = true;
        save(all);
        throw new CapReached(`${phase}: "${label}" needs ${credits} credits but ${total(r)} of ${limit} are used`);
      }
      r.entries.push({ at: new Date().toISOString(), label, credits });
      save(all);
    },
    summary: () => `${phase}: ${total(record(load()))} of ${cap} credits`,
  };
}
