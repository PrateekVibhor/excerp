// Plan 16: the evidence (spec 16, section 4). A researched or linked posting is one shared row reused by every course that uses it; a
// pasted description is a private row that never counts. The page text is never stored.
import type pg from 'pg';

export type Match = 'exact' | 'alias' | 'similar';

export interface Posting {
  company: string;
  roleTitle: string;
  designation?: string;
  url: string;
  match: Match;
  foundVia: 'tracked_search' | 'open_search' | 'user';
  postedAt?: Date;
}

const squash = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

export function createSources(pool: pg.Pool, now: () => Date = () => new Date()) {
  /** A posting counts toward criticality if its title matches the role and its employer has no counted posting for the role yet. */
  async function counts(roleId: string, company: string, match: Match, url: string): Promise<boolean> {
    if (match === 'similar') return false;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM sources WHERE role_id = $1 AND company = $2 AND counts_for_criticality AND visibility = 'shared' AND url IS DISTINCT FROM $3 LIMIT 1`,
      [roleId, company, url],
    );
    return rowCount === 0;
  }

  /** One shared row per role and link: a posting seen again is refreshed, not duplicated. */
  async function upsertShared(roleId: string, p: Posting, origin: 'research' | 'user_url'): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO sources (role_id, role_title, designation, company, url, origin, found_via, match, counts_for_criticality, posted_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (role_id, url) WHERE visibility = 'shared' AND url IS NOT NULL
       DO UPDATE SET role_title = EXCLUDED.role_title, designation = EXCLUDED.designation, posted_at = coalesce(EXCLUDED.posted_at, sources.posted_at), last_seen_at = EXCLUDED.last_seen_at
       RETURNING id`,
      [roleId, p.roleTitle, p.designation ?? null, p.company, p.url, origin, p.foundVia, p.match, await counts(roleId, p.company, p.match, p.url), p.postedAt ?? null, now()],
    );
    return rows[0].id;
  }

  return {
    upsertPosting: (roleId: string, p: Posting) => upsertShared(roleId, p, 'research'),

    /** A link the reader gave, fetched by the server: a shared source that counts once per employer, and only if its title matches. */
    registerLink: (roleId: string, p: Posting) => upsertShared(roleId, { ...p, foundVia: 'user' }, 'user_url'),

    /** A pasted description: private to its owner, with no link and no company, and it never counts. */
    async registerPaste(roleId: string, ownerId: string, p: { roleTitle: string }): Promise<string> {
      const { rows } = await pool.query(
        `INSERT INTO sources (role_id, role_title, company, url, origin, found_via, match, counts_for_criticality, visibility, owner_account_id, status, last_seen_at)
         VALUES ($1, $2, 'Not named', NULL, 'user_paste', 'user', 'exact', false, 'private', $3, 'current', $4) RETURNING id`,
        [roleId, p.roleTitle, ownerId, now()],
      );
      return rows[0].id;
    },

    /** Puts a source in a course. A source that is not used needs a reason. Attaching twice changes nothing. */
    async attach(courseId: string, sourceId: string, use: 'pool' | 'reader' | 'not_used', reason?: string): Promise<void> {
      if (use === 'not_used' && !reason) throw new Error('a source that is not used needs a reason');
      await pool.query(`INSERT INTO course_sources (course_id, source_id, use, reason) VALUES ($1, $2, $3, $4) ON CONFLICT (course_id, source_id) DO NOTHING`, [courseId, sourceId, use, reason ?? null]);
    },

    /** Replaces the skills a source asks for. A skill listed twice is one row. */
    async setSkills(sourceId: string, conceptIds: string[]): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM source_skills WHERE source_id = $1`, [sourceId]);
        await client.query(`INSERT INTO source_skills (source_id, concept_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [sourceId, conceptIds]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    /** Counts each shared skill's mentions from the skills of the role's current, counted postings. */
    async recountMentions(roleId: string): Promise<void> {
      await pool.query(
        `UPDATE role_concepts k SET
           mentions = (SELECT count(*) FROM source_skills ss JOIN sources s ON s.id = ss.source_id
                       WHERE ss.concept_id = k.id AND s.status = 'current' AND s.counts_for_criticality AND s.visibility = 'shared'),
           of_postings = (SELECT count(*) FROM sources s WHERE s.role_id = k.role_id AND s.status = 'current' AND s.counts_for_criticality AND s.visibility = 'shared')
         WHERE k.role_id = $1 AND k.visibility = 'shared'`,
        [roleId],
      );
    },

    /** Keeps a title another company uses for the role, but only from a confident match, and never the role's own name. */
    async learnAlias(roleId: string, titleSeen: string, confident: boolean): Promise<void> {
      if (!confident) return;
      const title = squash(titleSeen);
      if (!title || title === (await pool.query(`SELECT name FROM roles WHERE id = $1`, [roleId])).rows[0]?.name) return;
      await pool.query(
        `INSERT INTO role_aliases (role_id, title_seen, last_seen_at) VALUES ($1, $2, $3)
         ON CONFLICT (role_id, title_seen) DO UPDATE SET times_seen = role_aliases.times_seen + 1, last_seen_at = EXCLUDED.last_seen_at`,
        [roleId, title, now()],
      );
    },
  };
}
