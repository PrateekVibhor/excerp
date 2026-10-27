import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';

/** Where the hash of each deleted account is written, outside the database, so a restore from a backup can delete them again. */
export interface DeletionLog {
  record(hash: string, at: Date): Promise<void>;
}

/** How long the log is kept: a little longer than the backups it protects against (30 days). */
export const DELETION_LOG_DAYS = 35;
const DAY_MS = 86_400_000;

/**
 * One line per deleted account: the time and the SHA-256 of its Google sub. Never the sub, the email or the name.
 * The file should be on a volume that is not part of the database or its backups.
 */
export function createFileDeletionLog(path: string): DeletionLog & { prune(now: Date): Promise<number> } {
  return {
    async record(hash, at) {
      await appendFile(path, `${at.toISOString()} ${hash}\n`, { mode: 0o600 });
    },

    /** Drops lines older than the retention period. Returns how many were dropped. A missing file is nothing to do. */
    async prune(now) {
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        return 0;
      }
      const cutoff = now.getTime() - DELETION_LOG_DAYS * DAY_MS;
      const lines = content.split('\n').filter((line) => line.trim() !== '');
      const kept = lines.filter((line) => {
        const time = Date.parse(line.split(' ')[0]);
        return Number.isNaN(time) || time >= cutoff; // a line that cannot be read is kept, never silently lost
      });
      if (kept.length === lines.length) return 0;
      await writeFile(`${path}.tmp`, kept.map((l) => `${l}\n`).join(''), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return lines.length - kept.length;
    },
  };
}
