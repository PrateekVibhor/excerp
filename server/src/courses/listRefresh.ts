// List-course notifications. After the library changes, a ready list course's thin and missing concepts are rated again against the NEW sources only, with the
// shared rating function (a source counts only if it teaches the concept). A concept whose coverage went UP is announced, as one "coverage_improved" change
// each, in a new published version that carries copies of the course's rows. A concept whose coverage went down is written in place and silently, and a run in
// which nothing rose makes no version. This job is the only writer of a list course's stored ratings once the course is published.
import type pg from 'pg';
import type { Chat } from '../llm.ts';
import { MIN_HITS, rateSourceText, type Reader } from './coverage/coverage.ts';
import { libraryVersion } from './library/db.ts';
import { LINK_SHOWN } from './listCoverage.ts';
import { conceptBand, roleSlug, type Band } from './listMode.ts';
import { startVersionOn, createVersionStore } from './versions.ts';

export interface RefreshDeps { pool: pg.Pool; chat: Chat; read: Reader; now?: () => Date }
export type RefreshResult =
  | { status: 'skipped'; reason: 'not_a_ready_list_course' | 'no_readers' | 'up_to_date' | 'busy' }
  | { status: 'done'; rises: Array<{ concept: string; display: string; from: Band; to: Band }>; falls: number; complete: boolean; version: string | null };

const RANK: Record<Band, number> = { missing: 0, thin: 1, strong: 2 };
const STOP = new Set('with from that this into over under about their there when what which your using have been were will does also than then them they after before while'.split(' '));
const sources = (n: number) => `${n} vetted source${n === 1 ? '' : 's'}`;
/** What is true now, in plain words, with the old rating; no promise and no date. */
const summaryOf = (display: string, to: Band, library: number, from: Band) => `${display}: now ${to}, with ${sources(library)} (was ${from})`;

interface Concept { id: string; display: string; name: string; kind: string; terms: string[]; was: Band; library: number; other: number; links: Set<string> }

/** Does the library hold anything this ready list has not been rated against? (The same test the check itself starts with, without doing any of the work.) */
export async function listRefreshNeeded(pool: pg.Pool, courseId: string): Promise<boolean> {
  const course = (await pool.query(`SELECT published_version FROM courses WHERE id = $1 AND mode = 'list' AND status = 'ready' AND published_version IS NOT NULL`, [courseId])).rows[0];
  if (!course) return false;
  const stamp = Number((await pool.query(`SELECT coalesce(min(library_version), 0) AS s FROM list_concepts WHERE version_id = $1`, [course.published_version])).rows[0].s);
  return (await libraryVersion(pool)) > stamp;
}

/** Checks one list against the library, and stamps when it was last checked (a check that found the library unchanged is still a check; one that could not run is not). */
export async function refreshListCourse(deps: RefreshDeps, courseId: string): Promise<RefreshResult> {
  const result = await refreshOne(deps, courseId);
  if (result.status === 'done' || (result.status === 'skipped' && result.reason === 'up_to_date')) await deps.pool.query(`UPDATE courses SET last_checked_at = $2 WHERE id = $1`, [courseId, (deps.now ?? (() => new Date()))()]);
  return result;
}

async function refreshOne(deps: RefreshDeps, courseId: string): Promise<RefreshResult> {
  const { pool, chat, read } = deps;
  const now = deps.now ?? (() => new Date());
  const course = (await pool.query(`SELECT c.id, c.published_version, r.name AS role FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.id = $1 AND c.mode = 'list' AND c.status = 'ready' AND c.published_version IS NOT NULL`, [courseId])).rows[0];
  if (!course) return { status: 'skipped', reason: 'not_a_ready_list_course' };
  if (!(await pool.query(`SELECT 1 FROM course_inputs WHERE course_id = $1 LIMIT 1`, [courseId])).rowCount) return { status: 'skipped', reason: 'no_readers' };
  const slug = roleSlug(course.role);
  const old = course.published_version as string;
  const target = await libraryVersion(pool);
  const stamp = Number((await pool.query(`SELECT coalesce(min(library_version), 0) AS s FROM list_concepts WHERE version_id = $1`, [old])).rows[0].s);
  if (target <= stamp) return { status: 'skipped', reason: 'up_to_date' };
  if ((await pool.query(`SELECT 1 FROM course_versions WHERE course_id = $1 AND status = 'building'`, [courseId])).rowCount) return { status: 'skipped', reason: 'busy' };

  // the concepts as they are stored and as their links stand now (a retired library source no longer counts)
  const rows = (await pool.query(
    `SELECT c.concept_id AS id, c.display_name, c.band, k.name, k.kind, k.terms,
            coalesce(array_agg(l.library_source_id) FILTER (WHERE l.library_source_id IS NOT NULL), '{}') AS libs, count(l.id) FILTER (WHERE l.library_source_id IS NULL)::int AS other
     FROM list_concepts c JOIN role_concepts k ON k.id = c.concept_id LEFT JOIN list_links l ON l.version_id = c.version_id AND l.concept_id = c.concept_id AND ${LINK_SHOWN}
     WHERE c.version_id = $1 GROUP BY c.concept_id, c.display_name, c.band, k.name, k.kind, k.terms, c.position ORDER BY c.position`, [old])).rows;
  const concepts: Concept[] = rows.map((r) => ({ id: r.id, display: r.display_name, name: r.name, kind: r.kind, terms: r.terms as string[], was: r.band as Band, library: (r.libs as string[]).length, other: r.other, links: new Set(r.libs as string[]) }));

  // the sources that are new to this course: added, changed or reactivated since its stamp, and active, open, readable and for this role
  const changed = (await pool.query(`SELECT DISTINCT source_id FROM library_changes WHERE version > $1 AND source_id IS NOT NULL`, [stamp])).rows.map((r) => r.source_id as string);
  const fresh = changed.length
    ? (await pool.query(`SELECT id, name, url, pipeline_readable, entry->>'rationale' AS why FROM library_sources WHERE id = ANY($1) AND status = 'active' AND access = 'open' AND pipeline_readable AND $2 = ANY (applies_to) ORDER BY id`, [changed, slug])).rows
    : [];
  let complete = true;
  const added: Array<{ concept: Concept; source: { id: string; name: string; url: string; why: string } }> = [];
  for (const src of fresh) {
    const candidates = concepts.filter((k) => RANK[conceptBand({ library: k.library, other: k.other })] < RANK.strong && !k.links.has(src.id));
    if (!candidates.length) continue;
    const page = await read({ id: src.id, url: src.url, pipeline_readable: true });
    if (!page.ok) { complete = false; continue; }
    const cats = candidates.map((k) => {
      const words = k.kind === 'scenario' ? (k.name.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)) : [];
      return { id: k.id, name: k.name, description: `${k.name}, as a ${course.role} needs it`, aliases: [...new Set([...k.terms, ...words])] };
    });
    const rated = await rateSourceText(chat, { name: src.name, why: src.why ?? '' }, page.text, cats, MIN_HITS);
    for (const k of candidates) {
      const r = rated.get(k.id);
      if (!r) continue;
      if (r.verdict === 'teaches') added.push({ concept: k, source: { id: src.id, name: src.name, url: src.url, why: src.why ?? '' } });
      else if (r.verdict === 'unchecked' && r.hits >= MIN_HITS) complete = false; // the judge did not answer: retried next run
    }
  }
  for (const a of added) { a.concept.library++; a.concept.links.add(a.source.id); }

  // compare the new rating of every concept with the stored one
  const moved = concepts.map((k) => ({ k, to: conceptBand({ library: k.library, other: k.other }) }));
  const rises = moved.filter((m) => RANK[m.to] > RANK[m.k.was]);
  const falls = moved.filter((m) => RANK[m.to] < RANK[m.k.was]).length;
  const stampTo = complete ? target : stamp;
  const apply = async (client: pg.PoolClient, version: string) => {
    for (const a of added) {
      const pos = Number((await client.query(`SELECT coalesce(max(position) + 1, 0) AS p FROM list_links WHERE version_id = $1 AND concept_id = $2`, [version, a.concept.id])).rows[0].p);
      await client.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) VALUES ($1,$2,$3,$4,'article',$5,$6,$7,$8,$9)`,
        [courseId, version, a.concept.id, pos, a.source.name.slice(0, 300), new URL(a.source.url).hostname.replace(/^www\./, ''), a.source.url, a.source.why, a.source.id]);
    }
    // vetted sources first, as when the course was built
    for (const id of new Set(added.map((a) => a.concept.id))) {
      await client.query(`UPDATE list_links t SET position = r.n FROM (SELECT id, row_number() OVER (ORDER BY (library_source_id IS NULL), position, id) - 1 AS n FROM list_links WHERE version_id = $1 AND concept_id = $2) r WHERE t.id = r.id`, [version, id]);
    }
    for (const m of moved) await client.query(`UPDATE list_concepts SET band = $3, library_links = $4, other_links = $5, library_version = $6, rated_at = $7 WHERE version_id = $1 AND concept_id = $2`, [version, m.k.id, m.to, m.k.library, m.k.other, stampTo, now()]);
  };

  if (!rises.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await apply(client, old); // nothing rose: the stored rating follows the links in place, with no version and no change row
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { status: 'done', rises: [], falls, complete, version: null };
  }

  const client = await pool.connect();
  let version: string;
  try {
    await client.query('BEGIN');
    try {
      version = (await startVersionOn(client, courseId, {}, now())).id;
    } catch {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'busy' };
    }
    await client.query(`INSERT INTO list_concepts (course_id, version_id, concept_id, position, display_name, band, library_links, other_links, library_version, rated_at) SELECT course_id, $2, concept_id, position, display_name, band, library_links, other_links, library_version, rated_at FROM list_concepts WHERE version_id = $1`, [old, version]);
    await client.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) SELECT l.course_id, $2, l.concept_id, l.position, l.kind, l.title, l.source, l.url, l.why, l.library_source_id FROM list_links l WHERE l.version_id = $1 AND ${LINK_SHOWN}`, [old, version]);
    await apply(client, version);
    for (const m of rises) {
      await client.query(`INSERT INTO course_changes (course_id, version_id, kind, target, summary) VALUES ($1, $2, 'coverage_improved', $3, $4)`, [courseId, version, m.k.id, summaryOf(m.k.display, m.to, m.k.library, m.k.was)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  try {
    await createVersionStore(pool, now).publish(version);
  } catch (error) {
    await createVersionStore(pool, now).fail(version, 'publish_failed').catch(() => undefined);
    throw error;
  }
  return { status: 'done', rises: rises.map((m) => ({ concept: m.k.id, display: m.k.display, from: m.k.was, to: m.to })), falls, complete, version };
}

/** Every ready list course of a role (or of every role), one at a time; one course failing does not stop the others. */
export async function refreshListCourses(deps: RefreshDeps, slug?: string): Promise<{ courses: number; notified: number; errors: number }> {
  const all = (await deps.pool.query(`SELECT c.id, r.name FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.mode = 'list' AND c.status = 'ready' AND c.published_version IS NOT NULL ORDER BY c.id`)).rows as Array<{ id: string; name: string }>;
  const out = { courses: 0, notified: 0, errors: 0 };
  for (const c of all) {
    if (slug && roleSlug(c.name) !== slug) continue;
    out.courses++;
    try {
      const r = await refreshListCourse(deps, c.id);
      if (r.status === 'done' && r.rises.length) out.notified++;
    } catch {
      out.errors++;
    }
  }
  return out;
}
