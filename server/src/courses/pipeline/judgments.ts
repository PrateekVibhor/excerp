// A page judged for a concept of a role, remembered (by the concept's name, so another reader's list for the same role finds it). Written only for a real verdict; a rejection is a verdict too.
import type pg from 'pg';
import type { PageVerdict } from './sourceQuality.ts';

export const JUDGMENT_DAYS = 30;

/** The same page however it is written: no "www", fragment or trailing slash, host in lower case. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}

export function createJudgments(pool: pg.Pool, now: () => Date = () => new Date()) {
  return {
    async get(roleId: string, concept: string, url: string, domain: string, judge: string): Promise<Pick<PageVerdict, 'keep' | 'kind' | 'why'> | null> {
      const row = (await pool.query(
        `SELECT keep, kind, why FROM link_judgments WHERE role_id = $1 AND concept = $2 AND url_key = $3 AND domain = $4 AND judge = $5 AND judged_at > $6`,
        [roleId, concept.toLowerCase(), urlKey(url), domain, judge, new Date(now().getTime() - JUDGMENT_DAYS * 86_400_000)],
      )).rows[0];
      return row ? { keep: row.keep, kind: row.kind, why: row.why } : null;
    },
    async put(roleId: string, concept: string, url: string, domain: string, judge: string, v: Pick<PageVerdict, 'keep' | 'kind' | 'why'>): Promise<void> {
      await pool.query(
        `INSERT INTO link_judgments (role_id, concept, url_key, domain, judge, keep, kind, why, judged_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (role_id, concept, url_key, domain, judge) DO UPDATE SET keep = $6, kind = $7, why = $8, judged_at = $9`,
        [roleId, concept.toLowerCase(), urlKey(url), domain, judge, v.keep, v.kind, v.why, now()],
      );
    },
  };
}
