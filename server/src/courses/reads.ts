// Plan 16: what a signed-in account may read of a course, and in what shape (spec 16, section 5). An account that may not see a course
// is told it does not exist ('not_found'), never that it is forbidden. Content (chapters, concepts, quizzes) exists only for a ready course;
// a withdrawn course shows its notice and no content.
import type pg from 'pg';
import { LINK_SHOWN } from './listCoverage.ts';
import { conceptBand, meterOf } from './listMode.ts';
import { INDUSTRIES } from './industries.ts';
import { createCourseStore } from './store.ts';

export type Read<T> = { kind: 'ok'; body: T } | { kind: 'not_found' } | { kind: 'withdrawn' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = { kind: 'not_found' } as const;
const ok = <T>(body: T): Read<T> => ({ kind: 'ok', body });

export interface Visible {
  id: string;
  roleId: string;
  title: string;
  role: string;
  status: string;
  visibility: string;
  industry: string;
  mode: 'narrow' | 'list';
  poolSize: number;
  evidenceThin: boolean;
  failureReason: string | null;
  withdrawnAt: Date | null;
  withdrawalNote: string | null;
  publishedVersion: string | null;
}

/** The criticality bands in words, as shown with the posting count. */
export const HOW_CRITICALITY = 'Criticality is the share of these postings that mention a skill: High is 60% or more, Medium 25% to 59%, Low under 25%.';

export function createCourseReads(pool: pg.Pool, now: () => Date = () => new Date()) {
  const store = createCourseStore(pool);

  /** The course, if this account may see it at all. */
  async function visible(accountId: string, courseId: string): Promise<Visible | null> {
    if (!UUID.test(courseId)) return null;
    const { rows } = await pool.query(
      `SELECT c.id, c.role_id, c.title, r.name AS role, c.status, c.visibility, c.industry, c.mode, c.owner_account_id, c.requested_by, c.pool_size, c.evidence_thin, c.failure_reason,
              c.withdrawn_at, c.withdrawal_note, c.published_version,
              EXISTS (SELECT 1 FROM course_inputs i WHERE i.account_id = $1 AND i.course_id = c.id) AS enrolled
       FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.id = $2`,
      [accountId, courseId],
    );
    const c = rows[0];
    if (!c) return null;
    if (c.visibility === 'private' && c.owner_account_id !== accountId) return null;
    const mine = c.requested_by === accountId || c.enrolled || c.owner_account_id === accountId;
    const may = c.status === 'ready' ? true : c.status === 'building' || c.status === 'withdrawn' ? mine : c.requested_by === accountId || c.owner_account_id === accountId;
    if (!may) return null;
    return {
      id: c.id, roleId: c.role_id, title: c.title, role: c.role, status: c.status, visibility: c.visibility, industry: c.industry, mode: c.mode, poolSize: c.pool_size, evidenceThin: c.evidence_thin, failureReason: c.failure_reason,
      withdrawnAt: c.withdrawn_at, withdrawalNote: c.withdrawal_note, publishedVersion: c.published_version,
    };
  }

  /** Reading progress for the chapters the published version shows. */
  async function progress(accountId: string, courseId: string) {
    const outline = await store.publishedOutline(courseId);
    const ids = outline.flatMap((s) => s.chapters.map((c) => c.id));
    const read = new Set<string>(ids.length ? (await pool.query(`SELECT chapter_id FROM course_progress WHERE account_id = $1 AND chapter_id = ANY($2)`, [accountId, ids])).rows.map((r) => r.chapter_id) : []);
    return { outline, read, summary: { read: read.size, total: ids.length } };
  }

  const hasUpdates = async (accountId: string, courseId: string): Promise<boolean> =>
    (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM course_changes ch JOIN course_versions v ON v.id = ch.version_id JOIN course_seen s ON s.account_id = $1 AND s.course_id = $2
                      WHERE ch.course_id = $2 AND ch.published_at IS NOT NULL AND v.version > s.seen_version) AS yes`,
      [accountId, courseId],
    )).rows[0].yes;

  const seenVersion = async (accountId: string, courseId: string): Promise<number> =>
    (await pool.query(`SELECT seen_version FROM course_seen WHERE account_id = $1 AND course_id = $2`, [accountId, courseId])).rows[0]?.seen_version ?? 0;

  /** A list course's published concepts with the links that may be shown, rated from those links (so a retired library source is never counted or shown). */
  async function listContent(courseId: string, versionId: string) {
    const concepts = (await pool.query(
      `SELECT c.concept_id AS id, c.position, c.display_name, c.rated_at, c.library_version, k.name, k.plain_explanation, k.criticality, k.mentions, k.of_postings, cc.from_reader_source AS own, cc.tools,
              EXISTS (SELECT 1 FROM course_sources cs WHERE cs.course_id = cc.course_id AND cs.use = 'reader' AND cc.asked_by ? cs.source_id::text) AS in_posting
       FROM list_concepts c JOIN role_concepts k ON k.id = c.concept_id JOIN course_concepts cc ON cc.course_id = c.course_id AND cc.concept_id = c.concept_id
       WHERE c.version_id = $1 ORDER BY c.position`, [versionId])).rows;
    const links = (await pool.query(
      `SELECT l.concept_id, l.kind, l.title, l.source, l.url, l.why, l.library_source_id FROM list_links l WHERE l.version_id = $1 AND ${LINK_SHOWN} ORDER BY l.concept_id, l.position, l.id`, [versionId])).rows;
    const rows = concepts.map((k) => {
      const mine = links.filter((l) => l.concept_id === k.id);
      const library = mine.filter((l) => l.library_source_id).length;
      return { k, library, other: mine.length - library, band: conceptBand({ library, other: mine.length - library }), mine };
    });
    const meter = meterOf(rows.map((r) => ({ band: r.band, library: r.library, other: r.other })));
    const share = (n: number) => (meter.total ? n / meter.total : 0);
    const ratedAt = concepts.map((k) => k.rated_at as Date).sort((a, b) => b.getTime() - a.getTime())[0];
    const version = concepts.map((k) => (k.library_version === null ? null : Number(k.library_version))).filter((v): v is number => v !== null).sort((a, b) => b - a)[0] ?? null;
    return { rows, coverage: { ...meter, library_backed_share: share(meter.library_backed), any_link_share: share(meter.with_any_link), library_version: version, rated_at: ratedAt ? ratedAt.toISOString() : null } };
  }

  /** Content exists only for a ready course; a withdrawn one is reported as such. */
  async function content(accountId: string, courseId: string): Promise<Read<Visible>> {
    const c = await visible(accountId, courseId);
    if (!c) return notFound;
    if (c.status === 'withdrawn') return { kind: 'withdrawn' };
    return c.status === 'ready' && c.publishedVersion ? ok(c) : notFound;
  }

  return {
    /** May this account read the content of this course? Used by every endpoint that reads or writes in a course. */
    access: content,

    async home(accountId: string, courseId: string): Promise<Read<Record<string, unknown>>> {
      const c = await visible(accountId, courseId);
      if (!c) return notFound;
      const head = { id: c.id, status: c.status, title: c.title, role: c.role, industry: c.industry || null, mode: c.mode };
      if (c.status === 'withdrawn') {
        const p = await progress(accountId, c.id);
        return ok({ ...head, withdrawal: { note: c.withdrawalNote, withdrawn_at: c.withdrawnAt?.toISOString() ?? null }, progress: p.summary });
      }
      if (c.status === 'building') {
        const run = (await pool.query(`SELECT stage, percent FROM course_runs WHERE course_id = $1 AND kind <> 'source_finding' ORDER BY started_at DESC, id DESC LIMIT 1`, [c.id])).rows[0];
        return ok({ ...head, stage: run?.stage ?? '', percent: run?.percent ?? 0 });
      }
      if (c.status === 'failed') return ok({ ...head, failure_reason: c.failureReason });
      if (c.status !== 'ready') return ok(head);
      if (c.mode === 'list' && c.publishedVersion) {
        const list = await listContent(c.id, c.publishedVersion);
        const own = (await pool.query(`SELECT EXISTS (SELECT 1 FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 AND cs.use = 'reader' AND cs.state = 'approved' AND s.status = 'current') AS yes`, [c.id])).rows[0].yes as boolean;
        return ok({
          ...head, pool_size: c.poolSize, evidence_thin: c.evidenceThin, evidence: { thin: c.evidenceThin, similar_postings: c.poolSize, own_posting: own }, has_updates: await hasUpdates(accountId, c.id), seen_version: await seenVersion(accountId, c.id), industry_label: INDUSTRIES.find((i) => i.key === c.industry)?.label ?? null, coverage: list.coverage,
          concepts: list.rows.map((r) => ({
            ...conceptJson({ id: r.k.id, name: r.k.name, plain_explanation: r.k.plain_explanation, criticality: c.evidenceThin ? null : r.k.criticality, mentions: r.k.mentions, of_postings: r.k.of_postings, own: r.k.own, in_posting: r.k.in_posting, tools: r.k.tools }),
            display_name: r.k.display_name, position: r.k.position, band: r.band,
            resources: r.mine.map((l) => ({ kind: l.kind, title: l.title, source: l.source, url: l.url, why: l.why, vetted: l.library_source_id !== null })),
          })),
        });
      }

      const p = await progress(accountId, c.id);
      const quizzes = new Map<string, { best_score: number }>(
        (await pool.query(`SELECT section_id, best_score FROM section_quiz_results WHERE account_id = $1 AND section_id = ANY($2)`, [accountId, p.outline.map((s) => s.id)])).rows.map((r) => [r.section_id, { best_score: r.best_score }]),
      );
      return ok({
        ...head,
        pool_size: c.poolSize,
        evidence_thin: c.evidenceThin,
        has_updates: await hasUpdates(accountId, c.id),
        sections: p.outline.map((s) => ({
          id: s.id,
          title: s.title,
          chapters: s.chapters.map((ch) => ({ id: ch.id, title: ch.title, read: p.read.has(ch.id) })),
          quiz: { taken: quizzes.has(s.id), best_score: quizzes.get(s.id)?.best_score ?? null },
        })),
        progress: p.summary,
      });
    },

    async transparency(accountId: string, courseId: string): Promise<Read<Record<string, unknown>>> {
      const r = await content(accountId, courseId);
      if (r.kind !== 'ok') return r;
      const sources = (await pool.query(
        `SELECT s.company, s.role_title, s.designation, s.url, s.match
         FROM course_sources cs JOIN sources s ON s.id = cs.source_id
         WHERE cs.course_id = $1 AND cs.use = 'pool' AND cs.state = 'approved' AND s.status = 'current' AND s.counts_for_criticality ORDER BY s.company, s.id`,
        [courseId],
      )).rows;
      const date = (await pool.query(`SELECT v.published_at FROM courses c JOIN course_versions v ON v.id = c.published_version WHERE c.id = $1`, [courseId])).rows[0]?.published_at as Date | undefined;
      return ok({ line: `Built from ${sources.length} US job postings`, count: sources.length, sources, date: date?.toISOString() ?? null, how: HOW_CRITICALITY });
    },

    async chapter(accountId: string, courseId: string, chapterId: string): Promise<Read<Record<string, unknown>>> {
      const r = await content(accountId, courseId);
      if (r.kind !== 'ok') return r;
      if (!UUID.test(chapterId)) return notFound;
      const ch = await store.publishedChapter(courseId, chapterId);
      if (!ch) return notFound;
      const where = (await pool.query(`SELECT ch.section_id, ch.position FROM course_chapters ch WHERE ch.id = $1`, [chapterId])).rows[0];
      const concepts = (await pool.query(
        `SELECT k.id, k.name, k.plain_explanation, k.criticality, k.mentions, k.of_postings, coalesce(cc.from_reader_source, false) AS own, coalesce(cc.tools, '[]'::jsonb) AS tools, EXISTS (SELECT 1 FROM course_sources cs WHERE cs.course_id = cc.course_id AND cs.use = 'reader' AND cc.asked_by ? cs.source_id::text) AS in_posting
         FROM chapter_concepts x JOIN role_concepts k ON k.id = x.concept_id LEFT JOIN course_concepts cc ON cc.course_id = $1 AND cc.concept_id = k.id
         WHERE x.chapter_id = $2 ORDER BY x.position`,
        [courseId, chapterId],
      )).rows;
      return ok({
        id: ch.id, title: ch.title, body: ch.body, section_id: where.section_id, position: where.position, under_review: ch.status === 'under_review',
        concepts: concepts.map(conceptJson),
      });
    },

    /** A list course's coverage meter, with the rating of each concept (no links). Not found for a narrative course. */
    async coverage(accountId: string, courseId: string): Promise<Read<Record<string, unknown>>> {
      const r = await content(accountId, courseId);
      if (r.kind !== 'ok') return r;
      if (r.body.mode !== 'list' || !r.body.publishedVersion) return notFound;
      const list = await listContent(r.body.id, r.body.publishedVersion);
      return ok({
        meter: list.coverage,
        concepts: list.rows.map((x) => ({ id: x.k.id, name: x.k.name, display_name: x.k.display_name, position: x.k.position, band: x.band, library_links: x.library, other_links: x.other })),
      });
    },

    async concepts(accountId: string, courseId: string): Promise<Read<{ concepts: unknown[] }>> {
      const r = await content(accountId, courseId);
      if (r.kind !== 'ok') return r;
      const rows = (await pool.query(
        `SELECT k.id, k.name, k.plain_explanation, k.criticality, k.mentions, k.of_postings, cc.from_reader_source AS own, cc.tools, EXISTS (SELECT 1 FROM course_sources cs WHERE cs.course_id = cc.course_id AND cs.use = 'reader' AND cc.asked_by ? cs.source_id::text) AS in_posting
         FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY cc.position`,
        [courseId],
      )).rows;
      const thin = (await pool.query(`SELECT evidence_thin FROM courses WHERE id = $1`, [courseId])).rows[0]?.evidence_thin === true;
      return ok({ concepts: rows.map((k) => conceptJson(thin ? { ...k, criticality: null } : k)) });
    },

    /** A concept's resources: a shared concept to any signed-in account, a private one to its owner only. */
    async resources(accountId: string, conceptId: string, courseId?: string): Promise<Read<{ resources: unknown[] }>> {
      if (!UUID.test(conceptId)) return notFound;
      const k = (await pool.query(`SELECT visibility, owner_account_id FROM role_concepts WHERE id = $1`, [conceptId])).rows[0];
      if (!k || (k.visibility === 'private' && k.owner_account_id !== accountId)) return notFound;
      // The resources are those of the industry of the course the reader is in; a course that is missing or that this reader may not see means none.
      const industry = courseId ? ((await visible(accountId, courseId))?.industry ?? '') : '';
      const rows = (await pool.query(`SELECT kind, title, source, url, why FROM resources WHERE concept_id = $1 AND industry = $3 AND (kind <> 'video' OR checked_at > $2) ORDER BY checked_at, id`, [conceptId, new Date(now().getTime() - 25 * 86_400_000), industry])).rows; // a video's card data is YouTube API Data: never shown at 25 days old or more
      return ok({ resources: rows });
    },

    /** The published quiz for a section of this course, without the answers. */
    async quiz(accountId: string, courseId: string, sectionId: string): Promise<Read<Record<string, unknown>>> {
      const r = await content(accountId, courseId);
      if (r.kind !== 'ok') return r;
      if (!UUID.test(sectionId)) return notFound;
      if (!(await pool.query(`SELECT 1 FROM course_sections WHERE id = $1 AND course_id = $2`, [sectionId, courseId])).rowCount) return notFound;
      const quiz = await store.publishedQuiz(sectionId);
      if (!quiz) return notFound;
      const questions = (quiz.questions as Array<{ prompt: string; options: string[] }>).map((q) => ({ prompt: q.prompt, options: q.options }));
      return ok({ section_id: sectionId, version: quiz.version, questions });
    },

    /**
     * The courses this account has joined, most recently used first. Each carries what a list screen shows: the reader's own title for it (if they renamed it), who can see it,
     * its industry, when it was started and last used, and for a ready list the mini coverage count, when it was last checked for new sources and whether a check is running.
     */
    async mine(accountId: string): Promise<{ courses: unknown[] }> {
      const rows = (await pool.query(
        `SELECT c.id, c.title, r.name AS role, c.status, c.mode, c.visibility, c.independent, c.industry, c.published_version, c.last_checked_at, c.withdrawal_note, c.withdrawn_at,
                i.title AS custom_title, i.created_at AS joined_at, i.last_active_at,
                EXISTS (SELECT 1 FROM course_runs x WHERE x.course_id = c.id AND x.kind = 'refresh' AND x.finished_at IS NULL) AS refreshing
         FROM course_inputs i JOIN courses c ON c.id = i.course_id JOIN roles r ON r.id = c.role_id WHERE i.account_id = $1 ORDER BY i.last_active_at DESC, c.id`,
        [accountId],
      )).rows;
      const courses = [];
      for (const c of rows) {
        const item: Record<string, unknown> = {
          id: c.id, title: c.title, role: c.role, status: c.status, mode: c.mode, visibility: c.visibility, independent: c.independent,
          industry: c.industry || null, industry_label: INDUSTRIES.find((x) => x.key === c.industry)?.label ?? null,
          custom_title: c.custom_title, created_at: c.joined_at.toISOString(), last_active_at: c.last_active_at.toISOString(),
          checked_at: c.last_checked_at ? c.last_checked_at.toISOString() : null, refreshing: c.refreshing, coverage: null,
        };
        if (c.status === 'ready' || c.status === 'withdrawn') item.progress = (await progress(accountId, c.id)).summary;
        if (c.status === 'ready') item.has_updates = await hasUpdates(accountId, c.id);
        if (c.status === 'ready' && c.mode === 'list' && c.published_version) {
          const m = (await listContent(c.id, c.published_version)).coverage;
          item.coverage = { total: m.total, strong: m.strong, thin: m.thin, missing: m.missing };
        }
        if (c.status === 'withdrawn') item.withdrawal = { note: c.withdrawal_note, withdrawn_at: c.withdrawn_at?.toISOString() ?? null };
        courses.push(item);
      }
      return { courses };
    },
  };
}

interface ConceptRow {
  id: string;
  name: string;
  plain_explanation: string;
  criticality: string | null;
  mentions: number;
  of_postings: number;
  own: boolean;
  /** The reader's own pasted description asks for it (whether or not the market does too). */
  in_posting: boolean;
  /** Tools the reader's posting named for this concept, kept as a note. */
  tools: string[];
}

/** A concept as the app shows it. One that only the reader's own posting asks for has no market badge. */
function conceptJson(k: ConceptRow) {
  return { id: k.id, name: k.name, explanation: k.plain_explanation, criticality: k.own ? null : k.criticality, mentions: k.mentions, of_postings: k.of_postings, from_your_posting: k.own, in_your_posting: k.in_posting, tools: k.tools };
}

export type CourseReads = ReturnType<typeof createCourseReads>;
