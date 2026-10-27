// Plan 16: asking for a course, reviewing the sources, approving, swapping a source and cancelling (spec 16, section 5 and decisions 23, 28).
// Finding the sources and generating the course are the pipeline's work (phase 4); here a request queues that work, and approving
// moves the course to building with its first version and a queued run.
import type pg from 'pg';
import { enrolReader } from './enrol.ts';
import { isIndustryKey } from './industries.ts';
import { listModeAvailable, multiListAvailable } from './listMode.ts';
import { createCourseRequests, type LimitCode } from './requests.ts';
import type { createCourseSettings } from './settings.ts';
import { startVersionOn } from './versions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;
const MIN_POOL = 8;
const EXPIRES_AFTER_MS = 7 * 86_400_000;
const CLAIMED = `('building', 'ready', 'withdrawn')`;

/** A role as the system keeps it: lower case, single spaces, no stray punctuation at the ends. Null if it is not a plausible name. */
export function normalizeRole(raw: unknown): string | null {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const name = raw.trim().replace(/\s+/g, ' ').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}&+#)]+$/gu, '');
  if (name.length < 2 || name.length > 120 || !/\p{L}/u.test(name) || name.includes('://')) return null;
  return name;
}

export type Limited = { kind: 'limited'; code: LimitCode; retryAt: Date | null };
type Off = { kind: 'off' };

export type StartResult =
  | { kind: 'created'; courseId: string; status: 'finding_sources' }
  | { kind: 'existing'; courseId: string; status: string; existing: boolean }
  | { kind: 'invalid'; error: string }
  | { kind: 'withdrawn' }
  | Limited
  | Off;

export type StepResult<T> = { kind: 'ok'; body: T } | { kind: 'not_found' } | { kind: 'conflict'; error: string } | { kind: 'withdrawn' } | Limited | Off;

interface OwnedCourse {
  id: string;
  role_id: string;
  industry: string;
  mode: string;
  independent: boolean;
  status: string;
  visibility: string;
  replace_count: number;
  approved_at: Date | null;
}

/** The approval's change found the list no longer awaiting approval: another approval, a cancel or a delete came first. */
class ApprovalRaced extends Error {}

export function createCourseStarts(pool: pg.Pool, settings: ReturnType<typeof createCourseSettings>, now: () => Date = () => new Date()) {
  const requests = createCourseRequests(pool, settings, now);

  /** The course, if this account started it (or owns it). */
  async function owned(accountId: string, courseId: string, db: pg.Pool | pg.PoolClient = pool, lock = false): Promise<OwnedCourse | null> {
    if (!UUID.test(courseId)) return null;
    const { rows } = await db.query(
      `SELECT id, role_id, industry, mode, independent, status, visibility, replace_count, approved_at FROM courses WHERE id = $1 AND (requested_by = $2 OR owner_account_id = $2)${lock ? ' FOR UPDATE' : ''}`,
      [courseId, accountId],
    );
    return rows[0] ?? null;
  }

  const enrol = (db: pg.Pool | pg.PoolClient, accountId: string, courseId: string, typed: string, pasted?: string) => enrolReader(db, accountId, courseId, typed, now(), pasted);

  async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function roleId(name: string): Promise<string> {
    const alias = await pool.query(`SELECT role_id FROM role_aliases WHERE title_seen = $1`, [name]);
    if (alias.rows[0]) return alias.rows[0].role_id;
    const { rows } = await pool.query(`INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
    return rows[0].id;
  }

  /** After this attempt lost to another reader's course for the same role: close it, and enrol the reader in the winner. */
  async function supersede(accountId: string, losing: OwnedCourse, winner: { id: string; status: string }): Promise<StepResult<{ course_id: string; status: string; existing: true }>> {
    if (winner.status === 'withdrawn') return { kind: 'withdrawn' };
    await pool.query(`UPDATE courses SET status = 'cancelled', failure_reason = 'superseded' WHERE id = $1 AND status IN ('finding_sources', 'awaiting_approval')`, [losing.id]);
    await pool.query(`UPDATE course_requests SET outcome = 'served_existing' WHERE course_id = $1 AND account_id = $2 AND kind = 'approval' AND outcome = 'approved'`, [losing.id, accountId]);
    await enrol(pool, accountId, winner.id, '');
    return { kind: 'ok', body: { course_id: winner.id, status: winner.status, existing: true } };
  }

  return {
    /** A reader asks for a course: returns the role's course if there is one, their own pending attempt if they have one, or queues a new search. */
    async start(accountId: string, input: { role?: unknown; industry?: unknown; mode?: unknown; url?: unknown; text?: unknown }): Promise<StartResult> {
      if ((await settings.get()).coursesOff) return { kind: 'off' };
      if (typeof input.role !== 'string' || input.role.trim() === '') return { kind: 'invalid', error: 'role_required' };
      const name = normalizeRole(input.role);
      if (name === null) return { kind: 'invalid', error: 'role_invalid' };
      // The industry is a hint the reader may give; none (or an empty one) is a course of its own, and the pipeline guesses as it always did.
      let industry = '';
      if (input.industry !== undefined && input.industry !== null && input.industry !== '') {
        if (!isIndustryKey(input.industry)) return { kind: 'invalid', error: 'industry_invalid' };
        industry = input.industry;
      }
      // A course is narrative (written chapters) unless a list course is asked for, and a list course is offered only for roles that have a library folder.
      let mode: 'narrow' | 'list' = 'narrow';
      if (input.mode !== undefined && input.mode !== null && input.mode !== '') {
        if (input.mode !== 'narrow' && input.mode !== 'list') return { kind: 'invalid', error: 'mode_invalid' };
        mode = input.mode;
      }
      if (mode === 'list' && !listModeAvailable(name)) return { kind: 'invalid', error: 'list_mode_unavailable' };
      let url: string | null = null;
      if (input.url !== undefined && input.url !== null && input.url !== '') {
        try {
          const parsed = typeof input.url === 'string' && input.url.length <= 2000 ? new URL(input.url) : null;
          if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return { kind: 'invalid', error: 'url_invalid' };
          url = parsed.toString();
        } catch {
          return { kind: 'invalid', error: 'url_invalid' };
        }
      }
      let text = '';
      if (input.text !== undefined && input.text !== null) {
        if (typeof input.text !== 'string') return { kind: 'invalid', error: 'text_invalid' };
        text = input.text.trim();
        if (text.length > MAX_TEXT) return { kind: 'invalid', error: 'text_too_long' };
      }
      const private_ = text !== '';
      // A list built from a pasted posting for a business analyst role is its own list: it is never merged into an earlier list or replaces one.
      const independent = private_ && mode === 'list' && multiListAvailable(name);
      const rid = await roleId(name);

      if (!private_) {
        const shared = (await pool.query(`SELECT id, status FROM courses WHERE role_id = $1 AND industry = $2 AND mode = $3 AND visibility = 'shared' AND status IN ${CLAIMED}`, [rid, industry, mode])).rows[0];
        if (shared) {
          if (shared.status === 'withdrawn') return { kind: 'withdrawn' };
          const served = await requests.servedExisting(accountId, rid, shared.id);
          if (!served.ok) return { kind: 'off' };
          await enrol(pool, accountId, shared.id, name);
          return { kind: 'existing', courseId: shared.id, status: shared.status, existing: true };
        }
      }
      // An independent list is the same attempt only if it is the same posting (a double tap); any other posting is a list of its own.
      const pending = (
        await pool.query(
          `SELECT id, status FROM courses WHERE role_id = $1 AND industry = $4 AND mode = $5 AND requested_by = $2 AND visibility = $3 AND status IN ('finding_sources', 'awaiting_approval')
             ${independent ? 'AND EXISTS (SELECT 1 FROM course_inputs i WHERE i.course_id = courses.id AND i.account_id = $2 AND i.pasted_text = $6)' : ''} ORDER BY created_at DESC LIMIT 1`,
          independent ? [rid, accountId, 'private', industry, mode, text] : [rid, accountId, private_ ? 'private' : 'shared', industry, mode],
        )
      ).rows[0];
      if (pending) return { kind: 'existing', courseId: pending.id, status: pending.status, existing: false };

      const decision = await requests.sourceSearch(accountId, rid, null, { independent });
      if (!decision.ok) return decision.code === 'courses_off' ? { kind: 'off' } : { kind: 'limited', code: decision.code, retryAt: decision.retryAt };

      const courseId = await transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO courses (role_id, title, visibility, owner_account_id, requested_by, status, created_at, industry, mode, independent) VALUES ($1, $2, $3, $4, $5, 'finding_sources', $6, $7, $8, $9) RETURNING id`,
          [rid, name, private_ ? 'private' : 'shared', private_ ? accountId : null, accountId, now(), industry, mode, independent],
        );
        const id: string = rows[0].id;
        await enrol(client, accountId, id, [name, url, text].filter(Boolean).join('\n'), text);
        await client.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'source_finding', $2, 'queued', 0, $3)`, [id, accountId, now()]);
        await client.query(`UPDATE course_requests SET course_id = $1 WHERE id = $2`, [id, decision.requestId]);
        return id;
      });
      return { kind: 'created', courseId, status: 'finding_sources' };
    },

    /** What the reader is shown before approving: the matched sources, the near-matches left out, and what will be reused. */
    async sources(accountId: string, courseId: string): Promise<StepResult<Record<string, unknown>>> {
      if ((await settings.get()).coursesOff) return { kind: 'off' };
      const course = await owned(accountId, courseId);
      if (!course) return { kind: 'not_found' };
      const rows = (
        await pool.query(
          `SELECT s.id, s.company, s.role_title, s.designation, s.url, s.match, s.origin, s.counts_for_criticality, cs.use, cs.reason
           FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 AND cs.state <> 'replaced' ORDER BY s.company, s.id`,
          [courseId],
        )
      ).rows;
      const used = rows.filter((r) => r.use !== 'not_used').map((r) => ({
        id: r.id, company: r.company, role_title: r.role_title, designation: r.designation, url: r.url, match: r.match,
        origin: r.origin === 'research' ? 'Found by Excerp' : 'You provided', counts_toward_criticality: r.counts_for_criticality,
      }));
      const notUsed = rows.filter((r) => r.use === 'not_used').map((r) => ({ id: r.id, company: r.company, role_title: r.role_title, url: r.url, match: r.match, reason: r.reason }));
      const reuse = (
        await pool.query(
          `SELECT k.name, r.kind FROM course_reuse r JOIN role_concepts k ON k.id = r.concept_id
           WHERE r.course_id = $1 AND k.visibility = 'shared' ORDER BY CASE r.kind WHEN 'covered' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, k.name`,
          [courseId],
        )
      ).rows as Array<{ name: string; kind: 'covered' | 'related' | 'new' }>;
      const count = (kind: string) => reuse.filter((r) => r.kind === kind).length;
      const status = (await pool.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0].status;
      return {
        kind: 'ok',
        body: {
          status, sources: used, not_used: notUsed,
          reuse: { covered: count('covered'), related: count('related'), new: count('new'), concepts: reuse.map((r) => ({ name: r.name, kind: r.kind })) },
          replace_count: course.replace_count, replaces_left: Math.max(0, 2 - course.replace_count),
        },
      };
    },

    /** The reader approves the list: one new course a day and three a month; the course moves to building with its first version and a queued run. */
    async approve(accountId: string, courseId: string): Promise<StepResult<{ course_id: string; status: string; existing?: true }>> {
      if ((await settings.get()).coursesOff) return { kind: 'off' };
      const course = await owned(accountId, courseId);
      if (!course) return { kind: 'not_found' };
      if (course.status === 'building' && course.approved_at) return { kind: 'ok', body: { course_id: course.id, status: 'building' } }; // already approved: the same approval
      if (course.status !== 'awaiting_approval') return { kind: 'conflict', error: 'not_awaiting_approval' };
      // Every course needs eight similar postings, except an independent list, which needs one usable source in all (the reader's own posting is one).
      const usable = Number((await pool.query(`SELECT count(*) FROM course_sources WHERE course_id = $1 AND ${course.independent ? `use IN ('pool', 'reader')` : `use = 'pool'`} AND state <> 'replaced'`, [courseId])).rows[0].count);
      if (course.independent ? usable < 1 : usable < MIN_POOL) return { kind: 'conflict', error: course.independent ? 'no_source' : 'not_enough_postings' };

      /** Another course for this role and industry (or, for a private course, this reader, role and industry) that is already being built, ready or withdrawn. */
      const claimed = async () =>
        (
          course.visibility === 'shared'
            ? await pool.query(`SELECT id, status FROM courses WHERE role_id = $1 AND industry = $3 AND mode = $4 AND visibility = 'shared' AND status IN ${CLAIMED} AND id <> $2`, [course.role_id, courseId, course.industry, course.mode])
            : await pool.query(`SELECT id, status FROM courses WHERE role_id = $1 AND industry = $4 AND mode = $5 AND visibility = 'private' AND owner_account_id = $3 AND status IN ${CLAIMED} AND id <> $2`, [course.role_id, courseId, accountId, course.industry, course.mode])
        ).rows[0];
      // Another course for the same role is a reason to replace this one, except for an independent list, which is always its own.
      const early = course.independent ? undefined : await claimed();
      if (early) return supersede(accountId, course, early);

      let decision: Awaited<ReturnType<typeof requests.approval>>;
      try {
        decision = await requests.approval(accountId, course.role_id, courseId, { independent: course.independent });
      } catch (error) {
        // The list was deleted while the approval was being checked: the entry cannot point at it any more. That is "not found", not a failure.
        if ((error as { code?: string }).code === '23503' && !(await owned(accountId, courseId))) return { kind: 'not_found' };
        throw error;
      }
      if (!decision.ok) return decision.code === 'courses_off' ? { kind: 'off' } : { kind: 'limited', code: decision.code, retryAt: decision.retryAt };

      try {
        await transaction(async (client) => {
          const flipped = await client.query(`UPDATE courses SET status = 'building', approved_at = $2 WHERE id = $1 AND status = 'awaiting_approval' RETURNING id`, [courseId, now()]);
          if (!flipped.rowCount) throw new ApprovalRaced();
          await client.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND use IN ('pool', 'reader') AND state = 'proposed'`, [courseId]);
          await client.query(`UPDATE sources SET status = 'current' WHERE status = 'proposed' AND id IN (SELECT source_id FROM course_sources WHERE course_id = $1 AND use IN ('pool', 'reader'))`, [courseId]);
          const version = await startVersionOn(client, courseId, {}, now());
          const run = await client.query(
            `INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, started_at) VALUES ($1, $2, 'generation', $3, 'queued', 0, $4) RETURNING id`,
            [courseId, version.id, accountId, now()],
          );
          await client.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [version.id, run.rows[0].id]);
        });
      } catch (error) {
        // Another reader's course for the role got there first (the unique rule), or this attempt was changed under us.
        const winner = course.independent ? undefined : await claimed();
        if (winner) return supersede(accountId, course, winner);
        if (!(error instanceof ApprovalRaced)) throw error;
        // Another approval of this same list got there first (the app can send several at once). Its approval counts; this one leaves no second entry, and is told what is now true.
        await pool.query(`DELETE FROM course_requests WHERE id = $1 AND kind = 'approval'`, [decision.requestId]);
        const now_ = await owned(accountId, courseId);
        if (!now_) return { kind: 'not_found' };
        if (now_.status === 'building' && now_.approved_at) return { kind: 'ok', body: { course_id: now_.id, status: 'building' } }; // the same answer as an approval that was already given
        return { kind: 'conflict', error: 'not_awaiting_approval' };
      }
      return { kind: 'ok', body: { course_id: courseId, status: 'building' } };
    },

    /** "Not the same role": drops one found source and searches again. A swap is a search, and a course allows two. */
    async replace(accountId: string, courseId: string, sourceId: string): Promise<StepResult<{ course_id: string; status: string }>> {
      if ((await settings.get()).coursesOff) return { kind: 'off' };
      const course = await owned(accountId, courseId);
      if (!course || !UUID.test(sourceId)) return { kind: 'not_found' };
      if (course.status !== 'awaiting_approval') return { kind: 'conflict', error: 'not_awaiting_approval' };
      const link = (await pool.query(`SELECT use, state FROM course_sources WHERE course_id = $1 AND source_id = $2`, [courseId, sourceId])).rows[0];
      if (!link) return { kind: 'not_found' };
      if (link.use !== 'pool' || link.state === 'replaced') return { kind: 'conflict', error: 'cannot_replace' };
      if (course.replace_count >= 2) return { kind: 'conflict', error: 'replace_limit' };

      const decision = await requests.sourceSearch(accountId, course.role_id, courseId, { independent: course.independent });
      if (!decision.ok) return decision.code === 'courses_off' ? { kind: 'off' } : { kind: 'limited', code: decision.code, retryAt: decision.retryAt };
      await transaction(async (client) => {
        await client.query(`UPDATE course_sources SET state = 'replaced' WHERE course_id = $1 AND source_id = $2`, [courseId, sourceId]);
        await client.query(`UPDATE courses SET status = 'finding_sources', replace_count = replace_count + 1 WHERE id = $1`, [courseId]);
        await client.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, started_at) VALUES ($1, 'source_finding', $2, 'replace', 0, $3)`, [courseId, accountId, now()]);
      });
      return { kind: 'ok', body: { course_id: courseId, status: 'finding_sources' } };
    },

    /** Cancels a request before approval. Nothing is generated; the search still counts. Safe to repeat. */
    async cancel(accountId: string, courseId: string): Promise<StepResult<{ course_id: string; status: string }>> {
      if ((await settings.get()).coursesOff) return { kind: 'off' };
      const course = await owned(accountId, courseId);
      if (!course) return { kind: 'not_found' };
      const done = { kind: 'ok' as const, body: { course_id: courseId, status: 'cancelled' } };
      if (course.status === 'cancelled') return done;
      if (course.status !== 'finding_sources' && course.status !== 'awaiting_approval' && course.status !== 'building') return { kind: 'conflict', error: 'not_cancellable' };
      // One conditional update decides it: a build publishing at the same moment holds the row, so either this wins (and the publish is refused) or the publish wins (and this is not cancellable).
      const flipped = await transaction(async (client) => {
        const changed = await client.query(`UPDATE courses SET status = 'cancelled' WHERE id = $1 AND status IN ('finding_sources', 'awaiting_approval', 'building') RETURNING id`, [courseId]);
        if (!changed.rowCount) return false;
        await client.query(`UPDATE course_requests SET outcome = 'cancelled' WHERE course_id = $1 AND kind = 'source_search' AND outcome = 'started'`, [courseId]);
        // Nothing is deleted: the list, its runs and what they spent stay. A run not started yet is closed here; one running closes itself when it sees the cancel. The version being built is not left building.
        await client.query(`UPDATE course_runs SET finished_at = $2, error = 'cancelled by the reader' WHERE course_id = $1 AND finished_at IS NULL AND stage = 'queued'`, [courseId, now()]);
        await client.query(`UPDATE course_versions SET status = 'failed' WHERE course_id = $1 AND status = 'building'`, [courseId]);
        return true;
      });
      if (flipped) return done;
      const now_ = await owned(accountId, courseId); // it changed under us: a publish or another cancel got there first
      return now_?.status === 'cancelled' ? done : now_ ? { kind: 'conflict', error: 'not_cancellable' } : { kind: 'not_found' };
    },

    /** Closes requests not approved within seven days; they still count as searches. Returns how many. */
    async expireStale(): Promise<number> {
      const cutoff = new Date(now().getTime() - EXPIRES_AFTER_MS);
      const { rows } = await pool.query(
        `UPDATE courses SET status = 'cancelled', failure_reason = 'expired' WHERE status IN ('finding_sources', 'awaiting_approval') AND created_at < $1 RETURNING id`,
        [cutoff],
      );
      if (rows.length) await pool.query(`UPDATE course_requests SET outcome = 'expired' WHERE course_id = ANY($1) AND kind = 'source_search' AND outcome = 'started'`, [rows.map((r) => r.id)]);
      return rows.length;
    },
  };
}

export type CourseStarts = ReturnType<typeof createCourseStarts>;
