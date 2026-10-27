// Plan 16: the single list of companies discovery searches, shared by every role (spec 16, decision 29). Links and counts only, never page text.
import type pg from 'pg';

export const TRUST_AFTER_SUCCESSES = 3;
export const BLOCK_AFTER_FAILURES = 3;

export type CompanyStatus = 'candidate' | 'trusted' | 'blocked';
const STATUSES: readonly string[] = ['candidate', 'trusted', 'blocked'];

export interface NewCompany {
  employer: string;
  domain: string;
  careersUrl?: string;
  addedBy: 'seed' | 'search' | 'owner';
}

export function createTrackedCompanies(pool: pg.Pool, now: () => Date = () => new Date()) {
  const lower = (domain: string) => domain.trim().toLowerCase();
  return {
    /** Adds a company as a candidate. Returns false, changing nothing, if the domain is already listed. */
    async add(c: NewCompany): Promise<boolean> {
      const { rowCount } = await pool.query(
        `INSERT INTO tracked_companies (employer, domain, careers_url, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (domain) DO NOTHING`,
        [c.employer, lower(c.domain), c.careersUrl ?? null, c.addedBy],
      );
      return rowCount === 1;
    },

    /**
     * Records whether fetching a company's pages worked. A candidate becomes trusted after repeated successes; a company is blocked after
     * repeated failures that outweigh its successes. A blocked company stays blocked until the owner says otherwise.
     */
    async recordOutcome(domain: string, ok: boolean): Promise<void> {
      if (ok) {
        await pool.query(
          `UPDATE tracked_companies SET successes = successes + 1, last_checked_at = $2,
             status = CASE WHEN status = 'candidate' AND successes + 1 >= $3 THEN 'trusted' ELSE status END WHERE domain = $1`,
          [lower(domain), now(), TRUST_AFTER_SUCCESSES],
        );
      } else {
        await pool.query(
          `UPDATE tracked_companies SET failures = failures + 1, last_checked_at = $2,
             status = CASE WHEN status <> 'blocked' AND failures + 1 >= $3 AND failures + 1 > successes THEN 'blocked' ELSE status END WHERE domain = $1`,
          [lower(domain), now(), BLOCK_AFTER_FAILURES],
        );
      }
    },

    /** A site whose rules disallow fetching is blocked at once. */
    async blockForRobots(domain: string): Promise<void> {
      await pool.query(`UPDATE tracked_companies SET status = 'blocked', last_checked_at = $2 WHERE domain = $1`, [lower(domain), now()]);
    },

    /** The domains to search: everything not blocked. */
    async searchDomains(): Promise<string[]> {
      return (await pool.query(`SELECT domain FROM tracked_companies WHERE status <> 'blocked' ORDER BY domain`)).rows.map((r) => r.domain);
    },

    /** Every listed company, for the owner. */
    async list() {
      return (await pool.query(`SELECT domain, employer, status, successes, failures, added_by FROM tracked_companies ORDER BY status, domain`)).rows as Array<{ domain: string; employer: string; status: CompanyStatus; successes: number; failures: number; added_by: string }>;
    },

    async recordMatch(domain: string): Promise<void> {
      await pool.query(`UPDATE tracked_companies SET last_matched_at = $2 WHERE domain = $1`, [lower(domain), now()]);
    },

    /** The owner's edit. Unblocking starts the company's record again. Returns false for a domain that is not listed. */
    async setStatus(domain: string, status: CompanyStatus): Promise<boolean> {
      if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
      const { rowCount } = await pool.query(
        `UPDATE tracked_companies SET status = $2, successes = CASE WHEN status = 'blocked' AND $2 <> 'blocked' THEN 0 ELSE successes END,
           failures = CASE WHEN status = 'blocked' AND $2 <> 'blocked' THEN 0 ELSE failures END WHERE domain = $1`,
        [lower(domain), status],
      );
      return rowCount === 1;
    },

    async setCareersUrl(domain: string, url: string): Promise<boolean> {
      return (await pool.query(`UPDATE tracked_companies SET careers_url = $2 WHERE domain = $1`, [lower(domain), url])).rowCount === 1;
    },
  };
}
