// Plan 16, phase 4: the generation run for an approved course (spec 16, section 6, stages 4 to 12). Every stage is its own tested module; this
// wires them together, writes what each produces, and publishes the version only when every check has passed. A failing stage fails the run
// with its reason, the version is marked failed, and nothing a reader can see changes.
import type pg from 'pg';
import type { Chat } from '../../llm.ts';
import { createSources } from '../sources.ts';
import { createVersionStore } from '../versions.ts';
import { checkChapter, gateReasons, decide, driftedClaims, verifyDrift, rewriteNote, type CheckedClaim, type LedgerClaim } from './accuracy.ts';
import { writeChapter, type ChapterConcept } from './chapters.ts';
import type { ExtractClient } from './clients.ts';
import { industryPhrase } from '../industries.ts';
import { loadLibrary, sourcesFor, type Library } from '../library/load.ts';
import { finderDenied } from '../gaps/tier.ts';
import { MIN_HITS, rateSourceText } from '../coverage/coverage.ts';
import { conceptBand, displayNames, roleSlug } from '../listMode.ts';
import { mapPhrases } from '../taxonomy/map.ts';
import { loadTaxonomyFromDb } from '../taxonomy/db.ts';
import { currentLibraryVersion } from '../listCoverage.ts';
import { fetchSourceText } from '../library/text.ts';
import { deriveIndustry, industryForConcept, strongestAlternate } from './domain.ts';
import { coherencePass, type WrittenChapter } from './coherence.ts';
import { planCards } from './coverage.ts';
import { classifyDelta, loadReusePool, type Classified, type PoolConcept } from './delta.ts';
import type { SearchClient } from './postings.ts';
import { buildConcepts, type ConceptEvidence } from './rank.ts';
import { readPosting, readPostings } from './read.ts';
import { matchConceptsToSources, researchFromLibrary, type LibrarySource } from './libraryResearch.ts';
import { referenceFor, topUpResources, type Judge, type ResourceRow } from './reference.ts';
import { mapLimit } from './limit.ts';
import { runStages, type RunResult, type Stage } from './run.ts';
import { scopeCheck } from './scope.ts';
import { makeSectionQuiz } from './sectionQuiz.ts';
import { sequenceConcepts } from './sequence.ts';
import { judgePage, type Page, type PageVerdict } from './sourceQuality.ts';
import { createJudgments, urlKey } from './judgments.ts';
import { clearSnapshot, loadSnapshot, saveSnapshot, type Snapshot } from './snapshot.ts';
import { planStory } from './story.ts';
import { findVideos, VIDEO_DATA_DAYS, type YoutubeClient } from './video.ts';

export interface BuildDeps {
  pool: pg.Pool;
  chat: Chat;
  search: SearchClient;
  extract: ExtractClient;
  youtube: YoutubeClient;
  reachable: (url: string) => Promise<boolean>;
  now?: () => Date;
  creditBudget?: number;
  /** Where the plan and chapter text are kept as they are produced, so a build queued again does not write them twice. */
  snapshotDir?: string;
  /** A build queued again that must not pay for research: every concept uses what is stored, however little. */
  noResearch?: boolean;
  /** Called with every chapter's claim count and flagged count each time the QA agent has checked it. */
  onClaims?: (r: { chapter: string; round: 'first' | 'afterRewrite'; claims: number; flagged: number; flaggedClaims: string[]; blocking: string[]; review: string[]; driftCleared: string[]; exempted: string[] }) => void;
  onStage?: Parameters<typeof runStages>[1]['onStage'];
  onStageStart?: Parameters<typeof runStages>[1]['onStageStart'];
  /** A separate (smaller) model for judging web pages, and the name that goes into remembered verdicts so a change of model starts afresh. Without it the main model judges. */
  judgeChat?: Chat;
  judgeId?: string;
  /** How many concepts the reference and list stages work on at once (default 4; 1 is one after another). */
  concurrency?: number;
  /** Opens a page to judge it, for the link-quality pass of a list course (tests give a stub; by default the page is fetched without credentials). */
  readPage?: (url: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /**
   * Library-first research, off unless given (Plan 16, part 3, step C). A concept the role's reference library covers is grounded from it and not searched
   * for; every other concept is researched live as before. `dir` is server/reference-library; the fetcher and the fact threshold are for tests.
   */
  library?: { /** Either the folder of library files, or a loader (the database copy). */ dir?: string; load?: () => Promise<Library>; fetcher?: (url: string, init?: RequestInit) => Promise<Response>; minFacts?: number };
}

const MIN_POOL = 8;
const NEXT_CHECK_DAYS = 45;

interface Evidence { sourceId: string; skills: string[]; scenarios: string[]; counts: boolean; /** The reader's own pasted description: it adds concepts but is not one of the postings. */ reader?: boolean }
interface Ctx {
  courseId: string; versionId: string; roleId: string; roleName: string; roleDescription: string;
  /** The reader a private course belongs to (null for a shared one): the owner of the concepts only their pasted description asks for. */
  ownerId: string | null;
  /** The industry key the reader chose ('' when none): the research hint in place of the pipeline's own guess, and the key what is researched is kept under. */
  industry: string;
  mode: 'narrow' | 'list';
  /** An independent list owns its private concepts (each carries the course's id), so nothing it builds or removes can touch another of the reader's lists. */
  independent: boolean;
  /** An independent list built from fewer than eight similar postings: it has no market numbers of its own to write, so it only reads the role's shared concepts. */
  thin: boolean;
  evidence: Evidence[];
  concepts: ConceptEvidence[];
  ids: Map<string, string>; // concept name -> role_concepts id
  delta: Map<string, Classified>;
  pagesByConcept: Map<string, Page[]>;
  order: string[];
  bible?: { setting: string; character: string; thread: string; voice: string };
  sections: Array<{ id: string; title: string; summary: string; chapters: Array<{ id: string; title: string; concepts: string[] }> }>;
  written: WrittenChapter[];
  excerpts: Array<{ chapterId: string; claim: string; category: string; excerpt: string; url: string }>;
  quizzes: Map<string, unknown[]>;
  /** Concepts whose reference research was already stored (a build queued again): their facts are the ledger the QA agent checks against. */
  stored: Set<string>;
  notes: string[];
  snap?: Snapshot;
}

class QaFailed extends Error {
  constructor(message: string) {
    super(`qa_failed: ${message}`);
  }
}

/** The short code a failed course keeps (spec: a first build that fails ends failed with qa_failed). */
const failureCode = (message: string) => (message.startsWith('qa_failed') ? 'qa_failed' : message.startsWith('not_enough_postings') ? 'not_enough_postings' : message.startsWith('no_source') ? 'no_source' : 'build_failed');

/** Why a build was stopped before it finished: the reader cancelled the list, or the list is gone (deleted). The message is what the run records. */
class BuildStopped extends Error {
  readonly why: 'cancelled' | 'list_deleted';
  constructor(why: 'cancelled' | 'list_deleted') {
    super(why === 'cancelled' ? 'cancelled: by the reader' : 'cancelled: list deleted');
    this.why = why;
  }
}
/** A run's recorded reason says it was stopped, not that it failed. */
export const isStopReason = (reason: string) => reason.startsWith('cancelled:');

export async function buildCourse(given: BuildDeps, courseId: string): Promise<RunResult & { notes: string[] }> {
  const { pool } = given;
  // Once a cancel or a delete has been noticed (at a stage boundary or before a concept's work, one small read each), every paid call that has not started yet is refused here:
  // a call already in flight may finish, but nothing new starts. Research already saved stays saved.
  let stopped: BuildStopped | null = null;
  const refuseIfStopped = () => {
    if (stopped) throw stopped;
  };
  const checkpoint = async () => {
    refuseIfStopped();
    const row = (await pool.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0] as { status: string } | undefined;
    if (!row) stopped = new BuildStopped('list_deleted');
    else if (row.status === 'cancelled') stopped = new BuildStopped('cancelled');
    refuseIfStopped();
  };
  const paid = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => (stopped ? Promise.reject(stopped) : fn(...a));
  const deps: BuildDeps = {
    ...given,
    chat: paid(given.chat),
    ...(given.judgeChat ? { judgeChat: paid(given.judgeChat) } : {}),
    search: { search: paid((q) => given.search.search(q)) },
    extract: { extract: paid((urls) => given.extract.extract(urls)) },
    youtube: { search: paid((q) => given.youtube.search(q)), videos: paid((ids) => given.youtube.videos(ids)) },
  };
  const { chat } = deps;
  const now = deps.now ?? (() => new Date());
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  // A link is checked and read once per build, however many concepts or stages ask: the answer (a promise, so concurrent askers share it) is kept by address.
  const once = <A, R>(fn: (a: A) => Promise<R>) => {
    const seen = new Map<A, Promise<R>>();
    return (a: A) => seen.get(a) ?? (seen.set(a, fn(a)), seen.get(a)!);
  };
  const reachable = once(deps.reachable);
  // A page judged for a concept of a role is remembered (30 days), so a rebuild, or another reader's list for the same role, does not ask the model again. The research
  // stage and the list stage look at different text (the search result, the fetched page) and each keeps its own verdict: the list stage's second look is a real filter.
  const judgments = createJudgments(deps.pool, deps.now);
  const judgeKey = (stage: 'research' | 'list') => `${deps.judgeId ?? 'main'}|${stage}|1`;
  // The shared record is tied to no reader and outlives a list or an account, so only a shared concept, or a standard skill category (a reader's phrasing folded into it), may be
  // written to it. A concept that exists only because of one reader's posting (a private concept row of its own) is judged like any other, but its verdicts stay in memory for
  // this one build, so the build does not judge the same page twice and nothing about the phrase is stored.
  const keptForBuild = new Map<string, Promise<PageVerdict>>();
  const sharedRow = new Map<string, Promise<boolean>>();
  const mayStore = (c: Ctx, name: string): Promise<boolean> => {
    if (c.concepts.find((k) => k.name === name)?.category) return Promise.resolve(true);
    const id = c.ids.get(name);
    if (!id) return Promise.resolve(false);
    if (!sharedRow.has(id)) sharedRow.set(id, pool.query(`SELECT visibility FROM role_concepts WHERE id = $1`, [id]).then((r) => r.rows[0]?.visibility === 'shared'));
    return sharedRow.get(id)!;
  };
  const judgeFor = (c: Ctx, stage: 'research' | 'list'): Judge => async (input) => {
    if (!(await mayStore(c, input.concept))) {
      const key = `${stage}|${input.concept.toLowerCase()}|${urlKey(input.page.url)}|${input.domain ?? ''}`;
      if (!keptForBuild.has(key)) keptForBuild.set(key, judgePage(deps.judgeChat ?? chat, input));
      const verdict = await keptForBuild.get(key)!;
      if (verdict.failed) keptForBuild.delete(key); // a failed answer is not worth keeping: the next ask tries again
      return verdict;
    }
    const known = await judgments.get(c.roleId, input.concept, input.page.url, input.domain ?? '', judgeKey(stage));
    if (known) return known;
    const verdict = await judgePage(deps.judgeChat ?? chat, input);
    if (!verdict.failed) await judgments.put(c.roleId, input.concept, input.page.url, input.domain ?? '', judgeKey(stage), verdict);
    return verdict;
  };

  const sources = createSources(pool, now);
  const versions = createVersionStore(pool, now);

  const course = (await pool.query(`SELECT c.status, c.role_id, c.industry, c.mode, c.independent, c.approved_at, c.visibility, c.owner_account_id, r.name, r.description FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.id = $1`, [courseId])).rows[0];
  if (!course) return { ok: false, runId: 0, stage: 'start', reason: new BuildStopped('list_deleted').message, notes: [] };
  if (course.status === 'cancelled') return { ok: false, runId: 0, stage: 'start', reason: new BuildStopped('cancelled').message, notes: [] };
  if (course.status !== 'building' || !course.approved_at) throw new Error(`the course is not approved and building (status ${course.status})`);
  const version = (await pool.query(`SELECT id, run_id FROM course_versions WHERE course_id = $1 AND status = 'building' ORDER BY version DESC LIMIT 1`, [courseId])).rows[0];
  if (!version) throw new Error('the course has no version being built');

  const ctx: Ctx = {
    courseId, versionId: version.id, roleId: course.role_id, roleName: course.name, roleDescription: course.description ?? '', ownerId: course.visibility === 'private' ? course.owner_account_id : null, industry: course.industry, mode: course.mode, independent: course.independent, thin: false,
    evidence: [], concepts: [], ids: new Map(), delta: new Map(), pagesByConcept: new Map(), order: [], sections: [], written: [], excerpts: [], quizzes: new Map(), stored: new Set(), notes: [],
    snap: deps.snapshotDir ? (loadSnapshot(deps.snapshotDir, courseId) ?? undefined) : undefined,
  };

  const stages: Stage<Ctx>[] = [
    {
      // Stage 4: read the sources that have not been read; the others keep their stored skills.
      name: 'read',
      async run(c, io) {
        const rows = (await pool.query(
          `SELECT s.id, s.url, s.company, s.role_title, s.counts_for_criticality AS counts, cs.use, s.owner_account_id FROM course_sources cs JOIN sources s ON s.id = cs.source_id
            WHERE cs.course_id = $1 AND cs.use IN ('pool', 'reader') AND cs.state = 'approved' AND s.status = 'current' ORDER BY s.company`,
          [c.courseId],
        )).rows as Array<{ id: string; url: string | null; company: string; role_title: string; counts: boolean; use: string; owner_account_id: string | null }>;
        const have = new Map<string, { skills: string[]; scenarios: string[] }>();
        for (const r of (await pool.query(`SELECT ss.source_id, rc.name, rc.kind FROM source_skills ss JOIN role_concepts rc ON rc.id = ss.concept_id WHERE ss.source_id = ANY($1::uuid[])`, [rows.map((r) => r.id)])).rows) {
          const e = have.get(r.source_id) ?? { skills: [], scenarios: [] };
          (r.kind === 'scenario' ? e.scenarios : e.skills).push(r.name);
          have.set(r.source_id, e);
        }
        const unread = rows.filter((r) => !have.has(r.id) && r.url);
        const text: Record<string, string> = {};
        for (let i = 0; i < unread.length; i += 5) {
          const batch = unread.slice(i, i + 5);
          io.credits(1);
          Object.assign(text, await deps.extract.extract(batch.map((b) => b.url!)));
        }
        const read = await readPostings(chat, unread.filter((r) => text[r.url!]).map((r) => ({ employer: r.company, url: r.url!, title: r.role_title, text: text[r.url!]!, match: 'exact' as const, alts: [] })));
        const kept = new Map(read.postings.map((p) => [p.url, p]));
        for (const r of rows) {
          const mine = have.get(r.id);
          const fresh = r.url ? kept.get(r.url) : undefined;
          const reader = r.use === 'reader';
          if (mine) c.evidence.push({ sourceId: r.id, skills: mine.skills, scenarios: mine.scenarios, counts: r.counts, ...(reader ? { reader } : {}) });
          else if (fresh) c.evidence.push({ sourceId: r.id, skills: fresh.skills, scenarios: fresh.scenarios, counts: r.counts });
          else if (reader && !r.url) {
            // The reader's own pasted description: read here, from the text kept with their record of the course. Not a US-only or title check; it is theirs.
            const pasted = r.owner_account_id ? (await pool.query(`SELECT pasted_text FROM course_inputs WHERE course_id = $1 AND account_id = $2`, [c.courseId, r.owner_account_id])).rows[0]?.pasted_text as string | null | undefined : undefined;
            const reading = pasted?.trim() ? await readPosting(chat, pasted) : null;
            if (reading && reading.skills.length + reading.scenarios.length > 0) c.evidence.push({ sourceId: r.id, skills: reading.skills, scenarios: reading.scenarios, counts: false, reader: true });
            else {
              await pool.query(`UPDATE sources SET status = 'dropped' WHERE id = $1`, [r.id]);
              c.notes.push('the pasted description could not be read, so the course is built without it');
            }
          } else await pool.query(`UPDATE sources SET status = 'dropped' WHERE id = $1`, [r.id]); // not a US posting, unreadable, or unreadable twice
        }
        const market = c.evidence.filter((e) => !e.reader).length; // the reader's own description is never one of the postings the minimum is of
        if (c.independent) {
          // An independent list needs one usable source in all, and the reader's own posting is one: with few or no similar postings it still builds, marked thin.
          if (c.evidence.length < 1) throw new Error('no_source: none of the sources could be read, so there is nothing to build the list from');
          c.thin = market < MIN_POOL;
        } else if (market < MIN_POOL) throw new Error(`not_enough_postings: ${market} postings remain after reading, at least ${MIN_POOL} are needed`);
      },
    },
    {
      // Stage 5: merge and rank, then write the concepts and what each source asks for.
      name: 'rank',
      async run(c) {
        if (c.snap?.concepts) c.concepts = c.snap.concepts; // the plan on file was made for these
        else {
          c.concepts = await buildConcepts(chat, c.evidence.map((e) => ({ skills: e.skills, scenarios: e.scenarios, countsForCriticality: e.counts })));
          const skillNames = new Set(c.concepts.filter((k) => k.kind === 'skill').map((k) => k.name));
          for (const k of c.concepts) if (k.kind === 'scenario' && skillNames.has(k.name)) k.name = `${k.name} in practice`; // one name per role, whatever the kind
          await foldReaderConcepts(c);
        }
        const pool_ = c.evidence.filter((e) => e.counts).length;
        for (const k of c.concepts) {
          // A thin list never writes its small pool's numbers onto the role's shared concepts: every concept is read as it stands, or kept private to the list.
          if ((k.fromReaderSource || c.thin) && c.ownerId) {
            // Only the reader's own description asks for it (or the list is thin): the concept is theirs. A concept the role already has (shared) is used as it is; otherwise it is private to
            // the reader and never added to the role's shared concepts, whose shares and mentions it must not touch.
            const shared = (await pool.query(`SELECT id FROM role_concepts WHERE role_id = $1 AND lower(name) = lower($2) AND visibility = 'shared'`, [c.roleId, k.name])).rows[0];
            const id = shared
              ? shared.id
              : (c.independent
                ? await pool.query(
                    `INSERT INTO role_concepts (role_id, name, kind, terms, mentions, of_postings, criticality, visibility, owner_account_id, course_id) VALUES ($1, $2, $3, $4::jsonb, 0, $5, NULL, 'private', $6, $7)
                     ON CONFLICT (course_id, lower(name)) WHERE visibility = 'private' AND course_id IS NOT NULL DO UPDATE SET terms = EXCLUDED.terms, of_postings = EXCLUDED.of_postings RETURNING id`,
                    [c.roleId, k.name, k.kind, JSON.stringify(k.terms), pool_, c.ownerId, c.courseId],
                  )
                : await pool.query(
                    `INSERT INTO role_concepts (role_id, name, kind, terms, mentions, of_postings, criticality, visibility, owner_account_id) VALUES ($1, $2, $3, $4::jsonb, 0, $5, NULL, 'private', $6)
                     ON CONFLICT (owner_account_id, role_id, lower(name)) WHERE visibility = 'private' AND course_id IS NULL DO UPDATE SET terms = EXCLUDED.terms, of_postings = EXCLUDED.of_postings RETURNING id`,
                    [c.roleId, k.name, k.kind, JSON.stringify(k.terms), pool_, c.ownerId],
                  )).rows[0].id;
            c.ids.set(k.name, id);
            continue;
          }
          const { rows } = await pool.query(
            `INSERT INTO role_concepts (role_id, name, kind, terms, mentions, of_postings, criticality) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
             ON CONFLICT (role_id, lower(name)) WHERE visibility = 'shared' DO UPDATE SET terms = EXCLUDED.terms, mentions = EXCLUDED.mentions, of_postings = EXCLUDED.of_postings, criticality = EXCLUDED.criticality
             RETURNING id`,
            [c.roleId, k.name, k.kind, JSON.stringify(k.publicTerms ?? k.terms), k.mentions, pool_, k.criticality], // only names a public posting used: a reader's wording never goes on a shared row
          );
          c.ids.set(k.name, rows[0].id);
        }
        if (c.ownerId) {
          // What this reader's earlier build of the course made and this one did not (a phrasing since merged away) is removed, so no stale private concept lingers.
          const keep = [...c.ids.values()];
          if (c.independent) {
            // Only this list's own concepts are looked at; the reader's other lists are never touched.
            await pool.query(`DELETE FROM role_concepts WHERE course_id = $1 AND visibility = 'private' AND id <> ALL($2::uuid[])`, [c.courseId, keep]);
          } else {
            await pool.query(`DELETE FROM course_concepts WHERE course_id = $1 AND concept_id IN (SELECT id FROM role_concepts WHERE visibility = 'private' AND owner_account_id = $2 AND role_id = $3) AND concept_id <> ALL($4::uuid[])`, [c.courseId, c.ownerId, c.roleId, keep]);
            await pool.query(`DELETE FROM role_concepts WHERE visibility = 'private' AND owner_account_id = $1 AND role_id = $2 AND course_id IS NULL AND id <> ALL($3::uuid[]) AND NOT EXISTS (SELECT 1 FROM course_concepts cc WHERE cc.concept_id = role_concepts.id)`, [c.ownerId, c.roleId, keep]);
          }
        }
        const termOwner = (kind: 'skill' | 'scenario') => {
          const m = new Map<string, string>();
          for (const k of c.concepts) if (k.kind === kind) for (const t of k.terms) m.set(t, k.name);
          return m;
        };
        const skillOwner = termOwner('skill');
        const scenarioOwner = termOwner('scenario');
        const norm = (s: string) => s.toLowerCase().replace(/[.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim();
        for (const e of c.evidence) {
          const names = [...e.skills.map((s) => skillOwner.get(norm(s))), ...e.scenarios.map((s) => scenarioOwner.get(norm(s)))].filter((n): n is string => !!n);
          await sources.setSkills(e.sourceId, [...new Set(names.map((n) => c.ids.get(n)!))]);
        }
      },
    },
    {
      // Stage 5 (reuse): compare with the published shared courses of similar roles.
      name: 'delta',
      async run(c) {
        const stored = async () => (await pool.query(`SELECT k.name, cr.kind, k.derived_from FROM course_reuse cr JOIN role_concepts k ON k.id = cr.concept_id WHERE cr.course_id = $1`, [c.courseId])).rows;
        const keep = (earlier: Awaited<ReturnType<typeof stored>>) => { for (const e of earlier) c.delta.set(e.name, { name: e.name, class: e.kind, ...(e.derived_from ? { match: e.derived_from } : {}) }); };
        // A build resumed from its written chapters keeps the reuse result they were built on; the comparison is not run again.
        if (c.snap?.bodies.length) {
          const earlier = await stored();
          if (earlier.length) return keep(earlier);
        }
        const existing: PoolConcept[] = (await loadReusePool(pool, c.roleId)).concepts;
        let failed = false;
        const classes = await classifyDelta(chat, c.concepts, existing, (message, total) => (c.notes.push(message), total && (failed = true)));
        if (failed) {
          // Nothing was compared: an earlier run's stored result stands, never overwritten with "all related".
          const earlier = await stored();
          if (earlier.length) {
            c.notes.push('the stored reuse result from the earlier run is kept');
            return keep(earlier);
          }
        }
        for (const k of classes) {
          c.delta.set(k.name, k);
          const match = existing.find((e) => e.id === k.match);
          await pool.query(`INSERT INTO course_reuse (course_id, from_course_id, concept_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (course_id, concept_id) DO UPDATE SET kind = EXCLUDED.kind, from_course_id = EXCLUDED.from_course_id`, [c.courseId, match?.courseId ?? null, c.ids.get(k.name), k.class]);
          if (match) await pool.query(`UPDATE role_concepts SET derived_from = $2 WHERE id = $1`, [c.ids.get(k.name), match.id]);
        }
      },
    },
    {
      // Stage 6: reference material, only for related and new concepts; covered ones reuse what is stored.
      name: 'reference',
      async run(c, io) {
        // The industry each concept is researched in comes from the postings that asked for it; the course-level phrase (all pool postings) is only the fallback.
        // The concepts are researched several at a time, so what they share is asked for once: a promise, not a value, is kept.
        let courseLevel: Promise<string> | undefined;
        const courseDomain = () =>
          (courseLevel ??= (async () => {
            const postings = (await pool.query(`SELECT s.company, s.role_title AS title FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 AND cs.use = 'pool' AND cs.state = 'approved'`, [c.courseId])).rows as Array<{ company: string; title: string }>;
            return deriveIndustry(chat, postings);
          })());
        // Library-first research, only when it was asked for: the library's text lives in this stage's closure and is dropped when the stage ends.
        const lib = deps.library && !deps.noResearch ? await openLibraryOnce(c, deps.library) : null;
        // A page of a link-only library source is never read for facts, from the library or from a live search that happens to return it: only its link is used.
        const linkOnlyKeys = new Set([...(lib?.byId.values() ?? [])].filter((x) => x.linkOnly).map((x) => normLink(x.url)));
        const liveSearch: SearchClient = linkOnlyKeys.size ? { search: async (q) => (await deps.search.search(q)).filter((h) => !linkOnlyKeys.has(normLink(h.url))) } : deps.search;
        const topUp = (have: ResourceRow[], concept: string, domain: string) => topUpResources({ role: c.roleName, concept, search: liveSearch, chat, reachable, judge: judgeFor(c, 'research'), io, domain: domain || undefined, have });
        const byPostings = new Map<string, Promise<string>>(); // concepts asked for by the same postings share one answer
        const notes: string[][] = [];
        await mapLimit(c.concepts, concurrency, async (k, index) => {
          await checkpoint(); // before each concept's research: a cancel or a delete stops here, with one small read
          notes[index] = [];
          const cls = c.delta.get(k.name);
          const id = c.ids.get(k.name)!;
          if (cls?.class === 'covered' && cls.match) {
            // What is carried over is what was researched with no industry or for this course's own industry, and it is kept under this course's industry.
            await pool.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, industry) SELECT $1, kind, title, source, url, why, $3 FROM resources WHERE concept_id = $2 AND industry IN ('', $3) AND NOT EXISTS (SELECT 1 FROM resources WHERE concept_id = $1 AND industry = $3)`, [id, cls.match, c.industry]);
            await pool.query(`INSERT INTO concept_claims (concept_id, claim, category, source_url, industry) SELECT $1, claim, category, source_url, $3 FROM concept_claims WHERE concept_id = $2 AND industry IN ('', $3) AND NOT EXISTS (SELECT 1 FROM concept_claims WHERE concept_id = $1 AND industry = $3)`, [id, cls.match, c.industry]);
            // Nothing of the right industry to carry over: it is researched like any other concept.
            if ((await pool.query(`SELECT 1 FROM concept_claims WHERE concept_id = $1 AND industry = $2 LIMIT 1`, [id, c.industry])).rowCount) return;
          }
          if (deps.noResearch) {
            c.stored.add(k.name);
            return;
          }
          const have = (await pool.query(
            `SELECT (SELECT count(*) FROM resources WHERE concept_id = $1 AND industry = $2)::int AS resources, (SELECT count(*) FROM concept_claims WHERE concept_id = $1 AND industry = $2)::int AS claims,
                    (SELECT min(checked_at) FROM resources WHERE concept_id = $1 AND industry = $2) AS oldest`, [id, c.industry])).rows[0];
          if (have.resources >= 2 && have.claims >= 1 && have.oldest && now().getTime() - new Date(have.oldest).getTime() < VIDEO_DATA_DAYS * 86_400_000) {
            c.stored.add(k.name); // researched already and still fresh: not paid for twice
            return;
          }
          if (lib) {
            const matched = (lib.matches[k.name] ?? []).map((sid) => lib.byId.get(sid)).filter((x): x is LibrarySource => !!x);
            const got = matched.length ? await researchFromLibrary({ role: c.roleName, concept: { name: k.name, terms: k.terms }, sources: matched, text: lib.text, chat, domain: industryPhrase(c.industry) || undefined, minFacts: lib.minFacts }) : null;
            await pool.query(`INSERT INTO library_use (course_id, concept_id, industry, outcome, source_ids, facts) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [c.courseId, id, c.industry, got?.covered ? 'library' : 'live', JSON.stringify(got?.sourceIds ?? []), got?.facts.length ?? 0]);
            if (got?.covered) {
              // Grounded from the library: no search, no page judge, no industry guess. The go-deeper videos are still found live.
              const found = await findVideos({ youtube: deps.youtube, chat, role: c.roleName, concept: k.name, now: now() });
              const videos: ResourceRow[] = found.kept.slice(0, 2).map((v) => ({ kind: 'video', title: v.title, source: v.channel, url: v.url, why: v.note }));
              const resources = await topUp([...got.resources.slice(0, 4 - videos.length), ...videos], k.name, industryPhrase(c.industry));
              if (resources.length < 2) notes[index]!.push(`"${k.name}" has fewer than two resources`);
              c.pagesByConcept.set(k.name, got.pages);
              await pool.query(`DELETE FROM resources WHERE concept_id = $1 AND industry = $2`, [id, c.industry]);
              for (const r of resources) await pool.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, checked_at, industry) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, r.kind, r.title.slice(0, 300), r.source, r.url, r.why, now(), c.industry]);
              await pool.query(`DELETE FROM concept_claims WHERE concept_id = $1 AND industry = $2`, [id, c.industry]);
              for (const f of got.facts) await pool.query(`INSERT INTO concept_claims (concept_id, claim, source_url, verified_at, industry, library_source_id) VALUES ($1, $2, $3, $4, $5, $6)`, [id, f.text, f.sources[0] ?? null, now(), c.industry, got.pages.find((p) => p.url === f.sources[0])?.sourceId ?? null]);
              if (got.facts[0]) await pool.query(`UPDATE role_concepts SET plain_explanation = $2 WHERE id = $1 AND ($3 OR plain_explanation = '')`, [id, got.facts[0].text.slice(0, 400), c.industry === '']);
              return;
            }
          }
          // A chosen industry is the hint for every concept; with none, the pipeline guesses from the postings that asked for the concept.
          let domain = industryPhrase(c.industry);
          if (!domain) {
            const asked = (await pool.query(`SELECT s.company, s.role_title AS title FROM source_skills ss JOIN sources s ON s.id = ss.source_id WHERE ss.concept_id = $1 ORDER BY s.company, s.id`, [id])).rows as Array<{ company: string; title: string }>;
            const key = asked.map((a) => `${a.company}|${a.title}`).join(';');
            if (!byPostings.has(key)) byPostings.set(key, industryForConcept(chat, asked, courseDomain));
            domain = await byPostings.get(key)!;
          }
          const ref = await referenceFor({ role: c.roleName, concept: k.name, search: liveSearch, chat, youtube: deps.youtube, reachable, judge: judgeFor(c, 'research'), io, now: now(), domain, alternate: strongestAlternate(k.name, k.terms) });
          const refResources = ref.shortfall ? await topUp(ref.resources, k.name, domain) : ref.resources;
          if (refResources.length < 2) notes[index]!.push(`"${k.name}" has fewer than two resources`);
          c.pagesByConcept.set(k.name, ref.pages);
          await pool.query(`DELETE FROM resources WHERE concept_id = $1 AND industry = $2`, [id, c.industry]);
          for (const r of refResources) await pool.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, checked_at, industry) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, r.kind, r.title.slice(0, 300), r.source, r.url, r.why, now(), c.industry]);
          await pool.query(`DELETE FROM concept_claims WHERE concept_id = $1 AND industry = $2`, [id, c.industry]);
          for (const f of ref.facts) await pool.query(`INSERT INTO concept_claims (concept_id, claim, source_url, verified_at, industry) VALUES ($1, $2, $3, $4, $5)`, [id, f.text, f.sources[0] ?? null, now(), c.industry]);
          // The concept's one-line explanation belongs to the course with no industry; a course for an industry only fills it in when it is still empty.
          if (ref.facts[0]) await pool.query(`UPDATE role_concepts SET plain_explanation = $2 WHERE id = $1 AND ($3 OR plain_explanation = '')`, [id, ref.facts[0].text.slice(0, 400), c.industry === '']);
        });
        for (const n of notes) c.notes.push(...n); // in concept order, whatever order the research finished in
      },
    },
    {
      // Stage 7: order every concept the course teaches.
      name: 'sequence',
      async run(c) {
        if (c.snap) return void (c.order = c.snap.order);
        c.order = (await sequenceConcepts(chat, c.roleName, c.concepts.map((k) => ({ name: k.name, mentions: k.mentions })))).order;
      },
    },
    {
      // Stage 8: the coverage plan and the story, written to the version being built (readers see none of it until it is published).
      name: 'plan',
      async run(c) {
        const plan = planCards(c.concepts.map((k) => ({ name: k.name, kind: k.kind, criticality: k.criticality, mentions: k.mentions, fromReaderSource: k.fromReaderSource })), c.order);
        const planned = c.snap?.story ? undefined : await planStory(chat, { role: c.roleName, sections: plan.sections });
        if (planned?.fallback) c.notes.push(`the story planner fell back to a generic story: ${planned.reason}`);
        if (planned?.repaired.length) c.notes.push(`chapter titles written for other work were replaced by the concept's name: ${planned.repaired.join('; ')}`);
        const story = c.snap?.story ?? planned!;
        if (deps.snapshotDir && !c.snap) saveSnapshot(deps.snapshotDir, c.courseId, (c.snap = { concepts: c.concepts, order: c.order, story: { bible: story.bible, sections: story.sections }, bodies: [], coherent: false }));
        // A first build that failed earlier left its sections behind (readers never saw them): start from a clean outline.
        if (!(await pool.query(`SELECT published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0].published_version) {
          await pool.query(`DELETE FROM course_sections WHERE course_id = $1`, [c.courseId]);
          await pool.query(`DELETE FROM story_bible WHERE course_id = $1 AND version_id <> $2`, [c.courseId, c.versionId]);
        }
        c.bible = story.bible;
        await pool.query(`INSERT INTO story_bible (course_id, version_id, setting, character, thread, voice) VALUES ($1, $2, $3, $4, $5, $6)`, [c.courseId, c.versionId, story.bible.setting, story.bible.character, story.bible.thread, story.bible.voice]);
        await placeConcepts(c, [...plan.sections.flat().flatMap((card) => card.concepts)]);
        for (const [si, s] of story.sections.entries()) {
          const sid = (await pool.query(`INSERT INTO course_sections (course_id, position, title, summary) VALUES ($1, $2, $3, $4) RETURNING id`, [c.courseId, si, s.title, s.summary])).rows[0].id as string;
          const section = { id: sid, title: s.title, summary: s.summary, chapters: [] as Ctx['sections'][number]['chapters'] };
          for (const [ci, ch] of s.chapters.entries()) {
            const cid = (await pool.query(`INSERT INTO course_chapters (section_id, position, added_in_version) VALUES ($1, $2, $3) RETURNING id`, [sid, ci, c.versionId])).rows[0].id as string;
            for (const [k, name] of ch.concepts.entries()) await pool.query(`INSERT INTO chapter_concepts (chapter_id, concept_id, position) VALUES ($1, $2, $3)`, [cid, c.ids.get(name), k]);
            section.chapters.push({ id: cid, title: ch.title, concepts: ch.concepts });
          }
          c.sections.push(section);
        }
      },
    },
    {
      // Stage 9: one chapter at a time, each written for this course.
      name: 'write',
      async run(c) {
        const previous: Array<{ title: string; gist: string }> = [];
        for (const s of c.sections) {
          for (const ch of s.chapters) {
            const saved = c.snap?.bodies[c.written.length]; // a text emptied to null in the file (by hand) is written again; the others are kept
            const r = saved != null ? { ok: true as const, body: saved } : await writeChapter(chat, await chapterInput(c, s.title, ch, previous));
            if (!r.ok) throw r.reason.includes('personal characteristic') ? new QaFailed(`chapter "${ch.title}" could not be written within scope: ${r.reason}`) : new Error(`chapter "${ch.title}" could not be written: ${r.reason}`);
            c.written.push({ id: ch.id, title: ch.title, concepts: ch.concepts, body: r.body });
            if (c.snap && deps.snapshotDir) saveSnapshot(deps.snapshotDir, c.courseId, ((c.snap.bodies[c.written.length - 1] = r.body), c.snap));
            previous.push({ title: ch.title, gist: r.body.split(/(?<=[.!?])\s+/)[0]!.slice(0, 140) });
          }
        }
      },
    },
    {
      // Stage 10: automated checks and one read-through; what it rewrites is checked again below.
      name: 'coherence',
      async run(c) {
        if (c.snap?.coherent) return;
        const r = await coherencePass(chat, { chapters: c.written, concepts: c.concepts.map((k) => k.name), bible: c.bible! });
        c.written = r.chapters;
        c.notes.push(...r.problems.map((p) => `coherence: ${p}`));
        if (c.snap && deps.snapshotDir) saveSnapshot(deps.snapshotDir, c.courseId, ((c.snap.bodies = c.written.map((w) => w.body)), (c.snap.coherent = true), c.snap));
      },
    },
    {
      // Stage 11: the scope check on everything written, then the QA agent on every chapter. A chapter that fails is rewritten once.
      name: 'check',
      async run(c) {
        // A build resumed after the check passed does not run it again.
        if (c.snap?.checked && c.snap.bodies.length === c.written.length) {
          for (const e of c.snap.checked.excerpts) if (c.written[e.index]) c.excerpts.push({ chapterId: c.written[e.index]!.id, claim: e.claim, category: e.category, excerpt: e.excerpt, url: e.url });
          c.notes.push('the scope check and the QA agent passed in an earlier run and were not repeated');
          return;
        }
        const items = () => [
          { id: 'bible', text: Object.values(c.bible!).join('. ') },
          ...c.sections.flatMap((s) => [{ id: `section ${s.id}`, text: `${s.title}. ${s.summary}` }]),
          ...c.written.map((w) => ({ id: `chapter ${w.id}`, text: `${w.title}. ${w.body}` })),
        ];
        let scope = await scopeCheck(chat, items());
        if (!scope.ok) {
          for (const v of scope.violations) {
            const w = c.written.find((x) => `chapter ${x.id}` === v.id);
            if (!w) continue;
            const s = c.sections.find((sec) => sec.chapters.some((ch) => ch.id === w.id))!;
            const input = await chapterInput(c, s.title, s.chapters.find((ch) => ch.id === w.id)!, []);
            const r = await writeChapter(chat, { ...input, fix: `the scope check failed it: ${v.why}` });
            if (r.ok) w.body = r.body;
          }
          scope = await scopeCheck(chat, items());
        }
        if (!scope.ok) throw new QaFailed(`the scope check still fails after one rewrite: ${scope.violations.map((v) => `${v.id}: ${v.why}`).join('; ')}`);

        for (const w of c.written) {
          const s = c.sections.find((sec) => sec.chapters.some((ch) => ch.id === w.id))!;
          const slot = s.chapters.find((ch) => ch.id === w.id)!;
          const pages = (await Promise.all(slot.concepts.map(async (n) => c.pagesByConcept.get(n) ?? (await storedPages(c, n))))).flat();
          const ledger = await ledgerFor(c, slot.concepts);
          let cleared: string[] = [];
          const attempt = async (body: string) => {
            cleared = [];
            const r = await checkChapter(chat, { role: c.roleName, chapter: body, pages, ledger });
            if (!r.ok) throw new QaFailed(`chapter "${w.title}": ${r.reason}`);
            c.notes.push(...r.notes);
            // A reused claim retold with a changed meaning is a flag even if the agent let it through; the yes/no check can clear it (verifyDrift).
            const drifts = driftedClaims(r.claims.map((x) => x.text), ledger);
            const sourceText = [...pages.map((p) => p.text), ...ledger.map((l) => l.claim)].join(' ');
            const out: CheckedClaim[] = [];
            for (const x of r.claims) {
              const mine = drifts.filter((d) => d.claim === x.text);
              if (!mine.length || x.verdict !== 'supported') { out.push(x); continue; }
              const v = await verifyDrift(chat, x.text, mine.map((d) => d.ledgerClaim), sourceText);
              if (v.failures.length) c.notes.push(`${v.failures.length} of 3 drift verification calls failed (${v.failures[0]}): "${x.text.slice(0, 80)}"`);
              if (v.cleared) { cleared.push(`${x.text} [numbers checked against the source: ${v.numbers.join(', ') || 'none'}]`); out.push(x); } else out.push({ ...x, verdict: 'contradicted' });
            }
            return out;
          };
          const taught = slot.concepts;
          let claims = await attempt(w.body);
          const report = (round: 'first' | 'afterRewrite') => deps.onClaims?.({
            chapter: w.title, round, claims: claims.length, flagged: claims.filter((x) => x.verdict !== 'supported').length,
            flaggedClaims: claims.filter((x) => x.verdict !== 'supported').map((x) => `${x.verdict}${x.category ? `/${x.category}` : ''}: ${x.text} [quote: ${x.quote || 'none'}]`),
            blocking: claims.filter((x) => gateReasons(x, taught).length).map((x) => `${x.text} (${gateReasons(x, taught).join('; ')})`),
            exempted: claims.filter((x) => gateReasons(x, taught).length === 0 && gateReasons(x).length > 0).map((x) => `${x.text} (would block: ${gateReasons(x).join('; ')})`),
            review: claims.filter((x) => x.definitionConflict).map((x) => `${x.text} [quote: ${x.quote}]`), driftCleared: cleared,
          });
          report('first');
          const first = decide(claims, 'first', taught);
          if (first.action === 'rewrite') {
            const input = await chapterInput(c, s.title, slot, []);
            const r = await writeChapter(chat, { ...input, fix: `a fact-check flagged these claims; remove them or state only what the facts support: ${first.flagged.map((f) => f.text).join(' | ')}.${rewriteNote(first.flagged, taught)}` });
            if (!r.ok) throw new QaFailed(`chapter "${w.title}" could not be rewritten: ${r.reason}`);
            w.body = r.body;
            if (c.snap && deps.snapshotDir) saveSnapshot(deps.snapshotDir, c.courseId, ((c.snap.bodies[c.written.indexOf(w)] = w.body), c.snap)); // a build that fails after the rewrite keeps the text it failed on
            claims = await attempt(w.body);
            report('afterRewrite');
            const second = decide(claims, 'afterRewrite', taught);
            if (second.action === 'fail') throw new QaFailed(`chapter "${w.title}": ${second.reasons.join('; ')}`);
          }
          for (const x of claims) {
            if (x.verdict === 'supported' && x.category && x.quote) {
              const page = pages.find((p) => p.text.replace(/\s+/g, ' ').toLowerCase().includes(x.quote.replace(/\s+/g, ' ').toLowerCase()));
              const url = page?.url ?? ledger.find((l) => l.claim.toLowerCase().includes(x.quote.toLowerCase()))?.sourceUrl ?? pages[0]?.url ?? '';
              if (url) c.excerpts.push({ chapterId: w.id, claim: x.text, category: x.category, excerpt: x.quote.slice(0, 300), url });
            }
          }
        }
        if (c.snap && deps.snapshotDir) saveSnapshot(deps.snapshotDir, c.courseId, ((c.snap.bodies = c.written.map((w) => w.body)), (c.snap.checked = { excerpts: c.excerpts.map((e) => ({ index: c.written.findIndex((w) => w.id === e.chapterId), claim: e.claim, category: e.category, excerpt: e.excerpt, url: e.url })) }), c.snap));
      },
    },
    {
      // Stage 12: a quiz for every section, written and checked with the existing quiz rules.
      name: 'quiz',
      async run(c) {
        for (const s of c.sections) {
          const text = s.chapters.map((ch) => c.written.find((w) => w.id === ch.id)!.body).join('\n\n');
          const q = await makeSectionQuiz(chat, text);
          if (!q.ok) throw new Error(`the quiz for "${s.title}" could not be made: ${q.reason}`);
          c.quizzes.set(s.id, q.questions);
        }
      },
    },
    {
      // Publish: write what readers will see, then switch the live version in one transaction.
      name: 'publish',
      async run(c) {
        for (const w of c.written) await pool.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, $3, $4)`, [w.id, c.versionId, w.title, w.body]);
        for (const [sectionId, questions] of c.quizzes) await pool.query(`INSERT INTO section_quizzes (section_id, version_id, questions, verified_at) VALUES ($1, $2, $3::jsonb, $4)`, [sectionId, c.versionId, JSON.stringify(questions), now()]);
        for (const e of c.excerpts) await pool.query(`INSERT INTO claim_excerpts (course_id, chapter_id, version_id, claim, category, excerpt, url) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [c.courseId, e.chapterId, c.versionId, e.claim, e.category, e.excerpt, e.url]);
        const poolSize = c.evidence.filter((e) => e.counts).length;
        await versions.publish(c.versionId, { course: { poolSize, evidenceThin: poolSize < MIN_POOL, lastCheckedAt: now(), nextCheckAt: new Date(now().getTime() + NEXT_CHECK_DAYS * 86_400_000) } });
      },
    },
  ];

  /** The facts a chapter may use for each of its concepts, from the ledger; a covered concept's facts are fixed input. */
  /**
   * The concepts only the reader's pasted description asks for are gathered by transferable skill: phrasings the role's skill categories put under one category become one
   * concept named for it (its terms keep every phrasing), and a tool in a phrase becomes the skill it is used for with the tool kept as a note. Only for a role that has a
   * taxonomy; a phrase the mapper cannot place, or would need a new category for, stays as it was. Shared concepts and the market's numbers are never touched.
   */
  async function foldReaderConcepts(c: Ctx): Promise<void> {
    if (!c.ownerId) return;
    const mine = c.concepts.filter((k) => k.fromReaderSource);
    if (!mine.length) return;
    const taxonomy = await loadTaxonomyFromDb(pool, roleSlug(c.roleName)).catch(() => null);
    if (!taxonomy) return;
    const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const { mapped } = await mapPhrases(chat, taxonomy, mine.map((k) => k.name)).catch(() => ({ mapped: [] }));
    const byName = new Map(mapped.map((m) => [key(m.phrase), m]));
    const validCategory = (m?: { categories: string[] }) => m?.categories.find((id) => taxonomy.categories.some((x) => x.id === id));
    // A concept whose own name the mapper cannot place (a group the merge named after a vendor, say) is placed by the phrasings it gathers: the category most of them fall under.
    const unplaced = mine.filter((k) => !validCategory(byName.get(key(k.name))));
    const viaTerms = new Map<string, { category: string; tools: string[] }>();
    if (unplaced.length) {
      const phrases = [...new Set(unplaced.flatMap((k) => k.terms.filter((t) => key(t) !== key(k.name))))];
      const { mapped: more } = phrases.length ? await mapPhrases(chat, taxonomy, phrases).catch(() => ({ mapped: [] })) : { mapped: [] };
      const byTerm = new Map(more.map((m) => [key(m.phrase), m]));
      for (const k of unplaced) {
        const hits = k.terms.map((t) => byTerm.get(key(t))).filter((m): m is NonNullable<typeof m> => !!m && !!validCategory(m));
        if (!hits.length) continue;
        const votes = new Map<string, number>();
        for (const m of hits) votes.set(validCategory(m)!, (votes.get(validCategory(m)!) ?? 0) + 1);
        const [category] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
        viaTerms.set(k.name, { category, tools: [...new Set(hits.flatMap((m) => m.tools))] });
      }
    }
    const groups = new Map<string, ConceptEvidence[]>();
    const tools = new Map<string, Set<string>>();
    for (const k of mine) {
      const m = byName.get(key(k.name));
      const category = validCategory(m) ?? viaTerms.get(k.name)?.category;
      if (!category) continue;
      groups.set(category, [...(groups.get(category) ?? []), k]);
      tools.set(category, new Set([...(tools.get(category) ?? []), ...(validCategory(m) ? m!.tools : viaTerms.get(k.name)?.tools ?? [])]));
    }
    const taken = new Set(c.concepts.filter((k) => !k.fromReaderSource).map((k) => k.name.toLowerCase()));
    const folded: ConceptEvidence[] = [];
    const gone = new Set<ConceptEvidence>();
    for (const [category, group] of groups) {
      const name = taxonomy.categories.find((x) => x.id === category)!.name.toLowerCase();
      if (taken.has(name)) continue; // the role already has a concept by that name: leave these phrasings as they are
      for (const k of group) gone.add(k);
      folded.push({ kind: 'skill', name, terms: [...new Set(group.flatMap((k) => [...k.terms, key(k.name)]))], mentions: 0, of: group[0]!.of, criticality: null, fromReaderSource: true, tools: [...(tools.get(category) ?? [])], category });
    }
    if (folded.length) {
      c.concepts = [...c.concepts.filter((k) => !gone.has(k)), ...folded];
      const joined = [...groups].filter(([category]) => folded.some((f) => f.category === category)).sort(([a], [b]) => a.localeCompare(b));
      c.notes.push(`skill categories: ${mine.length} concepts from your posting became ${mine.length - gone.size + folded.length} (${joined.map(([category, g]) => `${g.map((k) => k.name).sort().join(' + ')} -> ${taxonomy.categories.find((x) => x.id === category)!.name.toLowerCase()}`).join('; ')})`);
    }
  }

  /** The course's concepts, in the order given, with who asked for each (the postings that name it). */
  async function placeConcepts(c: Ctx, names: string[]): Promise<void> {
    const asked = new Map<string, string[]>();
    for (const e of c.evidence) for (const k of c.concepts) if ([...e.skills, ...e.scenarios].some((s) => k.terms.includes(s.toLowerCase().replace(/[.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim()))) asked.set(k.name, [...(asked.get(k.name) ?? []), e.sourceId]);
    for (const [i, name] of names.entries()) {
      const k = c.concepts.find((x) => x.name === name)!;
      await pool.query(`INSERT INTO course_concepts (course_id, concept_id, from_reader_source, asked_by, position, tools, skill_category) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7) ON CONFLICT (course_id, concept_id) DO UPDATE SET position = EXCLUDED.position, from_reader_source = EXCLUDED.from_reader_source, asked_by = EXCLUDED.asked_by, tools = EXCLUDED.tools, skill_category = EXCLUDED.skill_category`, [c.courseId, c.ids.get(name), k.fromReaderSource, JSON.stringify(asked.get(name) ?? []), i, JSON.stringify(k.tools ?? []), k.category ?? null]);
    }
  }

  /** The role's library for one build: its readable sources, the model's concept-to-source matches (one call), and a text fetcher that reads each source once. Null when there is nothing to use. */
  // Opened once per build: the reference stage and (for a list course) the list stage share the one model match and the one read of each source.
  let libraryOnce: ReturnType<typeof openLibrary> | undefined;
  const openLibraryOnce = (c: Ctx, cfg: NonNullable<BuildDeps['library']>) => (libraryOnce ??= openLibrary(c, cfg));
  async function openLibrary(c: Ctx, cfg: NonNullable<BuildDeps['library']>) {
    let loaded;
    try {
      loaded = cfg.load ? await cfg.load() : loadLibrary(cfg.dir!);
    } catch (error) {
      c.notes.push(`the reference library could not be loaded: ${(error as Error).message}`);
      return null;
    }
    const readable = sourcesFor(loaded, c.roleName.trim().toLowerCase().replace(/\s+/g, '-')).filter((s) => s.access === 'open' && s.pipeline_readable);
    if (readable.length === 0) return null;
    const byId = new Map<string, LibrarySource>(readable.map((s) => [s.id, { id: s.id, name: s.name, url: s.url, tier: s.tier, perspective: s.perspective, rationale: s.rationale, layer: s.layer, linkOnly: s.citation_policy === 'link-only' }]));
    const matches = await matchConceptsToSources(chat, c.roleName, c.concepts.map((k) => ({ name: k.name, terms: k.terms })), readable.map((s) => ({ id: s.id, name: s.name, layer: s.layer, tier: s.tier, rationale: s.rationale, free_parts: s.free_parts })));
    const texts = new Map<string, Promise<string | null>>();
    const text = (s: LibrarySource) => {
      if (!texts.has(s.id)) {
        texts.set(s.id, fetchSourceText({ id: s.id, url: s.url, pipeline_readable: true }, cfg.fetcher).then((r) => {
          if (r.ok) return r.text;
          c.notes.push(`library source ${s.id} could not be read: ${r.reason}`);
          return null;
        }));
      }
      return texts.get(s.id)!;
    };
    return { matches, byId, text, minFacts: cfg.minFacts ?? 2 };
  }

  async function chapterInput(c: Ctx, section: string, ch: { title: string; concepts: string[] }, previous: Array<{ title: string; gist: string }>) {
    const concepts: ChapterConcept[] = [];
    for (const name of ch.concepts) {
      const k = c.concepts.find((x) => x.name === name)!;
      const facts = (await pool.query(`SELECT claim FROM concept_claims WHERE concept_id = $1 AND industry = $2 ORDER BY verified_at, id`, [c.ids.get(name), c.industry])).rows.map((r) => r.claim as string);
      concepts.push({ name, terms: [name, ...k.terms.filter((t) => t !== name)], facts, reused: c.delta.get(name)?.class === 'covered' || c.stored.has(name) });
    }
    return { role: c.roleName, bible: c.bible!, section, title: ch.title, concepts, previous };
  }

  /** When a concept's pages are not in hand (reused, or researched in an earlier build), its stored verified facts stand in as the sources. */
  async function storedPages(c: Ctx, name: string): Promise<Page[]> {
    const rows = (await pool.query(`SELECT claim, source_url FROM concept_claims WHERE concept_id = $1 AND industry = $2 ORDER BY verified_at, id`, [c.ids.get(name), c.industry])).rows as Array<{ claim: string; source_url: string | null }>;
    const byUrl = new Map<string, string[]>();
    for (const r of rows) byUrl.set(r.source_url ?? 'stored facts', [...(byUrl.get(r.source_url ?? 'stored facts') ?? []), r.claim]);
    return [...byUrl].map(([url, claims]) => ({ url, title: name, text: claims.join(' ') }));
  }

  /** The ledger entries of concepts reused from another course: claims the chapter must retell faithfully. */
  async function ledgerFor(c: Ctx, names: string[]): Promise<Array<LedgerClaim & { sourceUrl: string | null }>> {
    const out: Array<LedgerClaim & { sourceUrl: string | null }> = [];
    for (const name of names) {
      if (c.delta.get(name)?.class !== 'covered' && !c.stored.has(name)) continue;
      for (const r of (await pool.query(`SELECT claim, category, source_url FROM concept_claims WHERE concept_id = $1 AND industry = $2`, [c.ids.get(name), c.industry])).rows) out.push({ concept: name, claim: r.claim, category: r.category, sourceUrl: r.source_url });
    }
    return out;
  }

  // A list course: after the reference research and the ordering, the concepts are written as a list. Each concept keeps the links the research found that
  // pass the link-quality pass (a vetted library source as it is; a video as the video rules screened it; any other page must open and pass the audience
  // judge for the role), is rated strong, thin or missing, and is shown under one short display name. Nothing is written for it: no plan, no chapters.
  const normLink = (url: string) => {
    try {
      const u = new URL(url);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  };
  const readPageOnce = deps.readPage ?? (async (url: string) => {
    const r = await fetchSourceText({ id: 'page', url, pipeline_readable: true }, deps.library?.fetcher);
    return r.ok ? { ok: true as const, text: r.text } : { ok: false as const, reason: r.reason };
  });
  const readPage = once(readPageOnce);
  async function libraryUrls(c: Ctx): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!deps.library) return out;
    try {
      const loaded = deps.library.load ? await deps.library.load() : loadLibrary(deps.library.dir!);
      for (const s of sourcesFor(loaded, c.roleName.trim().toLowerCase().replace(/\s+/g, '-'))) out.set(normLink(s.url), s.id);
    } catch (error) {
      c.notes.push(`the reference library could not be loaded for the list: ${(error as Error).message}`);
    }
    return out;
  }
  const listStage: Stage<Ctx> = {
    name: 'list',
    async run(c) {
      const names = [...c.order.filter((n) => c.ids.has(n)), ...c.concepts.map((k) => k.name).filter((n) => !c.order.includes(n))];
      await placeConcepts(c, names);
      const display = await displayNames(chat, c.roleName, names);
      const library = await libraryUrls(c);
      const vetted = deps.library ? await openLibraryOnce(c, deps.library) : null; // the role's vetted sources, matched to concepts by the model (one call); needs no search
      const libVersion = await currentLibraryVersion(pool);
      // Which vetted sources teach which concepts: the sources the model matched are each read once and rated once, for all their concepts together.
      const taught = new Map<string, Set<string>>();
      if (vetted) {
        const bySource = new Map<string, string[]>();
        for (const name of names) for (const sid of vetted.matches[name] ?? []) bySource.set(sid, [...(bySource.get(sid) ?? []), name]);
        // Each source is read and rated on its own, several at a time; the verdicts are applied afterwards in source order, so the result does not depend on who finished first.
        const verdicts = await mapLimit([...bySource], concurrency, async ([sid, concepts]) => {
          await checkpoint();
          const src = vetted.byId.get(sid);
          const text = src ? await vetted.text(src) : null;
          if (!src || text === null) return null;
          const cats = concepts.map((n) => {
            const k = c.concepts.find((x) => x.name === n)!;
            const words = k.kind === 'scenario' ? (n.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !LIST_STOP.has(w)) : [];
            return { id: n, name: n, description: `${n}, as a ${c.roleName} needs it`, aliases: [...new Set([...k.terms, ...words])] };
          });
          const rated = await rateSourceText(chat, { name: src.name, why: src.rationale }, text, cats, MIN_HITS);
          return { sid, taughtConcepts: concepts.filter((n) => rated.get(n)?.verdict === 'teaches') };
        });
        for (const v of verdicts) if (v) for (const n of v.taughtConcepts) taught.set(n, new Set([...(taught.get(n) ?? []), v.sid]));
      }
      await pool.query(`DELETE FROM list_links WHERE version_id = $1`, [c.versionId]);
      await pool.query(`DELETE FROM list_concepts WHERE version_id = $1`, [c.versionId]);
      const freshVideos = new Date(now().getTime() - VIDEO_DATA_DAYS * 86_400_000);
      // Each concept's links are checked and its row written on its own, several at a time; the rows carry their position, so the order they are written in does not matter.
      await mapLimit(names, concurrency, async (name, position) => {
        await checkpoint(); // before each concept's list-building work
        const id = c.ids.get(name)!;
        const rows = (await pool.query(`SELECT kind, title, source, url, why FROM resources WHERE concept_id = $1 AND industry = $2 AND (kind <> 'video' OR checked_at > $3) ORDER BY checked_at, id`, [id, c.industry, freshVideos])).rows as Array<{ kind: 'article' | 'blog' | 'video'; title: string; source: string; url: string; why: string }>;
        const kept: Array<(typeof rows)[number] & { libraryId: string | null }> = [];
        const seen = new Set<string>();
        // A vetted library source is a link only if the shared rating function (the one the library's coverage engine uses) says it teaches this concept.
        const concept = c.concepts.find((k) => k.name === name)!;
        for (const sid of taught.get(name) ?? []) {
          const src = vetted!.byId.get(sid)!;
          if (seen.has(normLink(src.url))) continue;
          seen.add(normLink(src.url));
          kept.push({ kind: 'article', title: src.name, source: new URL(src.url).hostname.replace(/^www\./, ''), url: src.url, why: src.rationale, libraryId: src.id });
        }
        void concept;
        for (const r of rows) {
          const key = normLink(r.url);
          if (seen.has(key)) continue;
          seen.add(key);
          const asLibrary = library.get(key) ?? null;
          const libraryId = asLibrary && taught.get(name)?.has(asLibrary) ? asLibrary : null; // a library page not shown to teach this concept is an ordinary link
          if (!libraryId && r.kind !== 'video') {
            if (finderDenied(r.url)) continue; // a social post, job board, forum, careers or course page is never a link
            if (!(await reachable(r.url))) continue;
            const page = await readPage(r.url);
            if (!page.ok) continue;
            const verdict = await judgeFor(c, 'list')({ role: c.roleName, concept: name, page: { url: r.url, title: r.title, text: page.text }, domain: industryPhrase(c.industry) || undefined });
            if (!verdict.keep) continue;
          }
          kept.push({ ...r, libraryId });
        }
        kept.sort((a, b) => Number(!!b.libraryId) - Number(!!a.libraryId));
        for (const [i, l] of kept.entries()) await pool.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [c.courseId, c.versionId, id, i, l.kind, l.title.slice(0, 300), l.source, l.url, l.why, l.libraryId]);
        const lib = kept.filter((l) => l.libraryId).length;
        await pool.query(`INSERT INTO list_concepts (course_id, version_id, concept_id, position, display_name, band, library_links, other_links, library_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [c.courseId, c.versionId, id, position, display.get(name)!, conceptBand({ library: lib, other: kept.length - lib }), lib, kept.length - lib, libVersion]);
      });
    },
  };
  const LIST_STOP = new Set('with from that this into over under about their there when what which your using have been were will does also than then them they after before while'.split(' '));
  const LIST_STAGES = ['read', 'rank', 'delta', 'reference', 'sequence'];
  const run = ctx.mode === 'list' ? [...stages.filter((s) => LIST_STAGES.includes(s.name)), listStage, stages.find((s) => s.name === 'publish')!] : stages;

  return finishBuild(deps, ctx, run, version.run_id, versions, now, checkpoint);
}

// The remaining stages are added below.
async function finishBuild(deps: BuildDeps, ctx: Ctx, stages: Stage<Ctx>[], runId: number, versions: ReturnType<typeof createVersionStore>, now: () => Date, checkpoint: () => Promise<void>): Promise<RunResult & { notes: string[] }> {
  const result = await runStages(deps.pool, { courseId: ctx.courseId, versionId: ctx.versionId, kind: 'generation', runId, now, creditBudget: deps.creditBudget, onStage: deps.onStage, onStageStart: deps.onStageStart, checkpoint }, stages, ctx);
  // A stage that failed because the list was cancelled or deleted is a stop, not a failure: the cancel already closed the version, a delete took it away, and the cancelled status is never overwritten.
  const stop = !result.ok && (isStopReason(result.reason) || (await checkpoint().then(() => false, () => true)));
  if (!result.ok && stop) {
    if (deps.snapshotDir) clearSnapshot(deps.snapshotDir, ctx.courseId);
    const reason = isStopReason(result.reason) ? result.reason : (await courseGone(deps.pool, ctx.courseId)) ? new BuildStopped('list_deleted').message : new BuildStopped('cancelled').message;
    return { ...result, reason, notes: ctx.notes };
  }
  if (!result.ok) await versions.fail(ctx.versionId, failureCode(result.reason));
  else if (deps.snapshotDir) clearSnapshot(deps.snapshotDir, ctx.courseId);
  return { ...result, notes: ctx.notes };
}

const courseGone = async (pool: pg.Pool, courseId: string) => !(await pool.query(`SELECT 1 FROM courses WHERE id = $1`, [courseId])).rowCount;
