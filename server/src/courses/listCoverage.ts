// List mode: what a list course may show. A link that is a vetted library source counts (and is shown) only while that source is still active in the database
// library, so a source that is flagged, suspended or removed drops out of the course at once. A library kept in files has no rows there and is taken as active.
// The stored ratings are written by one job only, listRefresh.ts (the in-place recompute that used to live here is retired).
import type pg from 'pg';

/** The SQL that is true for a link that may be shown: not a library link, or a library link whose source is not retired. */
export const LINK_SHOWN = `(l.library_source_id IS NULL OR NOT EXISTS (SELECT 1 FROM library_sources s WHERE s.id = l.library_source_id AND s.status <> 'active'))`;

/** The library's version now, or null when there is no database library (a library kept in files). */
export async function currentLibraryVersion(pool: pg.Pool): Promise<number | null> {
  try {
    const v = Number((await pool.query(`SELECT coalesce(max(version), 0) AS v FROM library_changes`)).rows[0].v);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}
