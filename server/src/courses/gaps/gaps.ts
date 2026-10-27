// Gap queue: a category the library covers thinly or not at all is a gap. It is filled only when the latest coverage rating says strong, so "filled" can
// never mean "we found something": it means the rated library now covers it.
import type pg from 'pg';

export interface Gap {
  role_slug: string;
  category_id: string;
  status: 'open' | 'candidates_ready' | 'filled' | 'dead_end';
  demand: number;
  attempts: number;
  credits_spent: number;
  first_seen_version: number;
  filled_version: number | null;
  last_attempt_at: Date | null;
  note: string;
}

const norm = (r: Record<string, unknown>): Gap => ({ ...(r as unknown as Gap), first_seen_version: Number(r.first_seen_version), filled_version: r.filled_version === null ? null : Number(r.filled_version), demand: Number(r.demand) });

/** Bring the queue in line with the newest rating: new gaps open, gaps now strong are filled, and a filled gap that fell back is open again. */
export async function reconcileGaps(pool: pg.Pool, slug: string): Promise<{ opened: number; filled: number; reopened: number }> {
  const version = (await pool.query(`SELECT max(library_version) AS v FROM category_coverage WHERE role_slug = $1`, [slug])).rows[0].v;
  if (version === null) return { opened: 0, filled: 0, reopened: 0 };
  const rated = (await pool.query(`SELECT category_id, band FROM category_coverage WHERE role_slug = $1 AND library_version = $2`, [slug, version])).rows as Array<{ category_id: string; band: string }>;
  const known = new Map((await pool.query(`SELECT category_id, status FROM library_gaps WHERE role_slug = $1`, [slug])).rows.map((r) => [r.category_id as string, r.status as string]));
  const out = { opened: 0, filled: 0, reopened: 0 };
  for (const r of rated) {
    const status = known.get(r.category_id);
    if (r.band === 'strong') {
      if (status && status !== 'filled') {
        await pool.query(`UPDATE library_gaps SET status = 'filled', filled_version = $3 WHERE role_slug = $1 AND category_id = $2`, [slug, r.category_id, version]);
        out.filled++;
      }
    } else if (!status) {
      await pool.query(`INSERT INTO library_gaps (role_slug, category_id, first_seen_version) VALUES ($1,$2,$3)`, [slug, r.category_id, version]);
      out.opened++;
    } else if (status === 'filled') {
      await pool.query(`UPDATE library_gaps SET status = 'open', filled_version = NULL WHERE role_slug = $1 AND category_id = $2`, [slug, r.category_id]);
      out.reopened++;
    }
  }
  // a gap is "ready" only while pages are waiting for admission
  await pool.query(`UPDATE library_gaps g SET status = 'open' WHERE role_slug = $1 AND status = 'candidates_ready' AND NOT EXISTS (SELECT 1 FROM library_candidates c WHERE c.role_slug = g.role_slug AND c.category_id = g.category_id AND c.status = 'proposed')`, [slug]);
  return out;
}

/** The gaps of a role (filled ones too), most wanted first. */
export async function gapsOf(pool: pg.Pool, slug: string): Promise<Gap[]> {
  return (await pool.query(`SELECT * FROM library_gaps WHERE role_slug = $1 ORDER BY demand DESC, category_id`, [slug])).rows.map(norm);
}

/** Someone asked for these categories again (a posting called for them): raise their demand. */
export async function addDemand(pool: pg.Pool, slug: string, categories: string[]): Promise<void> {
  for (const c of categories) await pool.query(`UPDATE library_gaps SET demand = demand + 1 WHERE role_slug = $1 AND category_id = $2`, [slug, c]);
}
