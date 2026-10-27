// Hand-made sample courses for the phase 2 tests (plan 16). Everything is built with plain SQL against a pool whose search_path is a
// throwaway schema (see courseDb.ts), so the tests exercise the real tables and rules. Lives outside src/ so it is not in the image.
import type pg from 'pg';

export const NOW = '2026-10-12T12:00:00.000Z';

// ---- the smallest valid row of each kind ----------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;
export const next = () => ++counter;
const code = (n: number) => [3, 2, 1, 0].map((i) => CROCKFORD[(n >> (5 * i)) & 31]).join('');

type Row = Record<string, unknown>;

/** Inserts a row from an object and returns the new row's id. */
async function insert(p: pg.Pool, table: string, row: Row): Promise<string> {
  const keys = Object.keys(row);
  const { rows } = await p.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row));
  return rows[0].id;
}

export async function account(p: pg.Pool): Promise<string> {
  const n = next();
  return insert(p, 'accounts', { google_sub: `sub-${n}`, ref: `EXC-${code(n)}-${code(n + 1000)}`, email: `user${n}@example.com` });
}
export const role = (p: pg.Pool, name = `role ${next()}`, description = 'A sample role.') => insert(p, 'roles', { name, description });
export const trackedCompany = (p: pg.Pool, over: Row = {}) => {
  const n = next();
  return insert(p, 'tracked_companies', { employer: `Company ${n}`, domain: `jobs${n}.example.com`, added_by: 'seed', ...over });
};
export const course = (p: pg.Pool, roleId: string, over: Row = {}) => insert(p, 'courses', { role_id: roleId, title: 'a role', visibility: 'shared', status: 'finding_sources', ...over });
export async function version(p: pg.Pool, courseId: string, v = 1, status = 'building'): Promise<string> {
  return insert(p, 'course_versions', { course_id: courseId, version: v, status, published_at: status === 'building' ? null : NOW });
}
export const section = (p: pg.Pool, courseId: string, position = 0) => insert(p, 'course_sections', { course_id: courseId, position, title: `Section ${position + 1}`, summary: 'What this part covers.' });
export const chapter = (p: pg.Pool, sectionId: string, versionId: string, position = 0) => insert(p, 'course_chapters', { section_id: sectionId, position, added_in_version: versionId });
export const concept = (p: pg.Pool, roleId: string, name = `skill ${next()}`, over: Row = {}) => insert(p, 'role_concepts', { role_id: roleId, name, visibility: 'shared', ...over });
/** A posting that counts toward criticality, unless it is a pasted description (which never does). */
export const source = (p: pg.Pool, roleId: string, over: Row = {}) => {
  const n = next();
  const origin = (over.origin as string | undefined) ?? 'research';
  return insert(p, 'sources', {
    role_id: roleId, role_title: 'Product Manager', designation: 'Senior', company: `Fixture Co ${n}`, url: `https://jobs${n}.example.com/job/${n}`, origin, found_via: 'tracked_search',
    match: 'exact', counts_for_criticality: origin !== 'user_paste', visibility: 'shared', status: 'current', posted_at: '2026-09-20T00:00:00.000Z', last_seen_at: NOW, ...over,
  });
};

/** The criticality rule of spec decision 5: 60% and 25%, and at least two mentions to be kept. */
export const bandOf = (mentions: number, of: number): 'high' | 'medium' | 'low' | null => (mentions < 2 ? null : mentions / of >= 0.6 ? 'high' : mentions / of >= 0.25 ? 'medium' : 'low');

const QUESTION = (n: number) => ({ prompt: `What does key idea ${n} say?`, options: [`Right ${n}`, `Wrong ${n}a`, `Wrong ${n}b`, `Wrong ${n}c`], correct_index: n % 4 });

// ---- whole courses --------------------------------------------------------------------------------------------------
export interface CourseFixture {
  roleId: string;
  courseId: string;
  versionId: string;
  sectionIds: string[];
  chapterIds: string[];
  conceptIds: string[];
  sourceIds: string[];
  requesterId: string;
}

export interface PublishedOptions {
  sections?: number;
  chaptersPerSection?: number;
  /** Postings in the evidence (eight or more for a real course). */
  postings?: number;
  roleName?: string;
}

/** Mentions per concept, cycled: with nine postings this gives high, medium and low skills. */
const MENTIONS = [8, 6, 5, 4, 3, 2, 7, 5, 3, 2, 6, 4];

/**
 * A shared course that is complete and live: nine postings from nine employers, skills with their mentions and bands, resources, a
 * published version with sections, chapters (two concepts each), texts, quizzes and a story bible, and a finished generation run.
 */
export async function publishedCourse(p: pg.Pool, opts: PublishedOptions = {}): Promise<CourseFixture & { roleName: string }> {
  const { sections = 2, chaptersPerSection = 3, postings = 9, roleName = `fixture role ${next()}` } = opts;
  const roleId = await role(p, roleName);
  const requesterId = await account(p);
  const chapterCount = sections * chaptersPerSection;

  // Skills and the postings that ask for them: concept i is asked for by the first MENTIONS[i] postings.
  const conceptIds: string[] = [];
  const sourceIds: string[] = [];
  for (let j = 0; j < postings; j++) sourceIds.push(await source(p, roleId));
  for (let i = 0; i < chapterCount * 2; i++) {
    const mentions = Math.min(MENTIONS[i % MENTIONS.length]!, postings);
    const id = await concept(p, roleId, `${roleName} skill ${i + 1}`, {
      plain_explanation: `A plain explanation of skill ${i + 1}.`, terms: JSON.stringify([`skill ${i + 1}`]), mentions, of_postings: postings, criticality: bandOf(mentions, postings),
    });
    conceptIds.push(id);
    for (let j = 0; j < mentions; j++) await p.query(`INSERT INTO source_skills (source_id, concept_id) VALUES ($1, $2)`, [sourceIds[j], id]);
    for (let r = 0; r < 2 + (i % 2); r++) await insert(p, 'resources', { concept_id: id, kind: ['article', 'blog', 'video'][r % 3], title: `Resource ${r + 1} for skill ${i + 1}`, source: 'Example Press', url: `https://resources.example.com/${i}/${r}`, why: 'Explains it well.' });
    await insert(p, 'concept_claims', { concept_id: id, claim: `A checked claim about skill ${i + 1}.`, source_url: 'https://resources.example.com/claim' });
  }

  // The course, claimed first so its version can be published, then made ready in one step.
  const courseId = await course(p, roleId, { title: roleName, status: 'building', requested_by: requesterId, pool_size: postings, approved_at: NOW, generated_at: NOW, next_check_at: '2026-11-26T12:00:00.000Z', model: 'fixture-model' });
  const versionId = await version(p, courseId, 1, 'published');
  await p.query(`UPDATE courses SET status = 'ready', published_version = $1 WHERE id = $2`, [versionId, courseId]);
  const runId = Number((await p.query(
    `INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, tavily_credits, tokens_in, tokens_out, started_at, finished_at) VALUES ($1, $2, 'generation', $3, 'publish', 100, 35, 300000, 40000, $4, $4) RETURNING id`,
    [courseId, versionId, requesterId, NOW],
  )).rows[0].id);
  await p.query(`UPDATE course_versions SET run_id = $1 WHERE id = $2`, [runId, versionId]);

  for (const s of sourceIds) await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, s]);
  for (let i = 0; i < conceptIds.length; i++) {
    await p.query(`INSERT INTO course_concepts (course_id, concept_id, position) VALUES ($1, $2, $3)`, [courseId, conceptIds[i], i]);
    await p.query(`INSERT INTO course_reuse (course_id, from_course_id, concept_id, kind) VALUES ($1, NULL, $2, 'new')`, [courseId, conceptIds[i]]);
  }

  const sectionIds: string[] = [];
  const chapterIds: string[] = [];
  for (let s = 0; s < sections; s++) {
    const sectionId = await section(p, courseId, s);
    sectionIds.push(sectionId);
    for (let c = 0; c < chaptersPerSection; c++) {
      const k = chapterIds.length;
      const chapterId = await chapter(p, sectionId, versionId, c);
      chapterIds.push(chapterId);
      await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, $3, $4)`, [chapterId, versionId, `Chapter ${k + 1}`, `The story continues in chapter ${k + 1}. ${'A few short sentences of narrative. '.repeat(4)}`]);
      await p.query(`INSERT INTO chapter_concepts (chapter_id, concept_id, position) VALUES ($1, $2, 0), ($1, $3, 1)`, [chapterId, conceptIds[2 * k], conceptIds[2 * k + 1]]);
    }
    await p.query(`INSERT INTO section_quizzes (section_id, version_id, questions, verified_at) VALUES ($1, $2, $3::jsonb, $4)`, [sectionId, versionId, JSON.stringify([QUESTION(1), QUESTION(2), QUESTION(3)]), NOW]);
  }
  await p.query(`INSERT INTO story_bible (course_id, version_id, setting, character, thread, voice) VALUES ($1, $2, 'A growing company', 'A new analyst', 'Shipping the first release', 'Warm and plain')`, [courseId, versionId]);

  return { roleId, courseId, versionId, sectionIds, chapterIds, conceptIds, sourceIds, requesterId, roleName };
}

/** A shared course the reader has not approved yet: eight proposed postings and one near-match listed as not used. */
export async function pendingCourse(p: pg.Pool, opts: { requesterId?: string; status?: 'finding_sources' | 'awaiting_approval' } = {}) {
  const requesterId = opts.requesterId ?? (await account(p));
  const roleId = await role(p);
  const courseId = await course(p, roleId, { status: opts.status ?? 'awaiting_approval', requested_by: requesterId });
  const sourceIds: string[] = [];
  for (let j = 0; j < 8; j++) {
    const id = await source(p, roleId, { status: 'proposed' });
    sourceIds.push(id);
    await p.query(`INSERT INTO course_sources (course_id, source_id, use) VALUES ($1, $2, 'pool')`, [courseId, id]);
  }
  const notUsedSourceId = await source(p, roleId, { status: 'proposed', match: 'similar', role_title: 'Product Marketing Manager', counts_for_criticality: false });
  await p.query(`INSERT INTO course_sources (course_id, source_id, use, reason) VALUES ($1, $2, 'not_used', 'title only resembles the role')`, [courseId, notUsedSourceId]);
  await p.query(`INSERT INTO course_runs (course_id, kind, requested_by, stage, percent, tavily_credits, started_at, finished_at) VALUES ($1, 'source_finding', $2, 'find', 100, 8, $3, $3)`, [courseId, requesterId, NOW]);
  await p.query(`INSERT INTO course_requests (account_id, role_id, course_id, kind, outcome, created_at) VALUES ($1, $2, $3, 'source_search', 'started', $4)`, [requesterId, roleId, courseId, NOW]);
  return { roleId, courseId, requesterId, sourceIds, notUsedSourceId };
}

/** A private course made from a pasted description: a private source and concept, one section and one chapter, owned by one account. */
export async function privateCourse(p: pg.Pool, opts: { ownerId?: string } = {}) {
  const ownerId = opts.ownerId ?? (await account(p));
  const roleId = await role(p);
  const pasteSourceId = await source(p, roleId, { origin: 'user_paste', url: null, found_via: 'user', visibility: 'private', owner_account_id: ownerId, counts_for_criticality: false, company: 'Not named', status: 'current' });
  const sharedConceptId = await concept(p, roleId, 'stakeholder management', { mentions: 6, of_postings: 9, criticality: 'high' });
  const privateConceptId = await concept(p, roleId, 'our internal reporting tool', { visibility: 'private', owner_account_id: ownerId });
  const courseId = await course(p, roleId, { visibility: 'private', owner_account_id: ownerId, requested_by: ownerId, status: 'building', approved_at: NOW, generated_at: NOW });
  const versionId = await version(p, courseId, 1, 'published');
  await p.query(`UPDATE courses SET status = 'ready', published_version = $1 WHERE id = $2`, [versionId, courseId]);
  await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'reader', 'approved')`, [courseId, pasteSourceId]);
  await p.query(`INSERT INTO course_concepts (course_id, concept_id, position) VALUES ($1, $2, 0)`, [courseId, sharedConceptId]);
  await p.query(`INSERT INTO course_concepts (course_id, concept_id, from_reader_source, asked_by, position) VALUES ($1, $2, true, $3::jsonb, 1)`, [courseId, privateConceptId, JSON.stringify([pasteSourceId])]);
  const sectionId = await section(p, courseId);
  const chapterId = await chapter(p, sectionId, versionId);
  await p.query(`INSERT INTO chapter_texts (chapter_id, version_id, title, body) VALUES ($1, $2, 'Chapter 1', 'A short story for one reader.')`, [chapterId, versionId]);
  await p.query(`INSERT INTO chapter_concepts (chapter_id, concept_id, position) VALUES ($1, $2, 0), ($1, $3, 1)`, [chapterId, sharedConceptId, privateConceptId]);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, 'Product manager at a payments company ...', $3)`, [ownerId, courseId, NOW]);
  return { roleId, courseId, ownerId, versionId, sectionId, chapterId, pasteSourceId, privateConceptId, sharedConceptId };
}

/** A published course the owner has withdrawn: it keeps its live version, and carries a note for its readers. */
export async function withdrawnCourse(p: pg.Pool, opts: { note?: string; from?: Awaited<ReturnType<typeof publishedCourse>> } = {}) {
  const base = opts.from ?? (await publishedCourse(p));
  await p.query(`UPDATE courses SET status = 'withdrawn', withdrawn_at = $1, withdrawal_note = $2 WHERE id = $3`, [NOW, opts.note ?? 'This course is being corrected.', base.courseId]);
  return base;
}

// ---- readers and what they do ---------------------------------------------------------------------------------------
/** Enrols an account in a course, optionally with read chapters, a quiz result and a last-active time. */
export async function enrolReader(
  p: pg.Pool,
  c: Pick<CourseFixture, 'courseId' | 'chapterIds' | 'sectionIds'>,
  opts: { accountId?: string; readChapters?: number; lastActiveAt?: string; quizBest?: number; typedText?: string } = {},
) {
  const accountId = opts.accountId ?? (await account(p));
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, last_active_at) VALUES ($1, $2, $3, $4)`, [accountId, c.courseId, opts.typedText ?? 'product manager', opts.lastActiveAt ?? NOW]);
  for (const ch of c.chapterIds.slice(0, opts.readChapters ?? 0)) await p.query(`INSERT INTO course_progress (account_id, chapter_id, read_at) VALUES ($1, $2, $3)`, [accountId, ch, NOW]);
  if (opts.quizBest !== undefined) await p.query(`INSERT INTO section_quiz_results (account_id, section_id, best_score, attempts, last_taken_at) VALUES ($1, $2, $3, 1, $4)`, [accountId, c.sectionIds[0], opts.quizBest, NOW]);
  return { accountId };
}

/** A flag on one of a course's chapters, with the chapter's text frozen into it. */
export async function flagChapter(p: pg.Pool, c: Pick<CourseFixture, 'courseId' | 'versionId' | 'chapterIds'>, reporterId: string, opts: { reason?: string; chapterIndex?: number; createdAt?: string } = {}) {
  const chapterId = c.chapterIds[opts.chapterIndex ?? 0]!;
  const text = (await p.query(`SELECT body FROM chapter_texts WHERE chapter_id = $1 AND version_id = $2`, [chapterId, c.versionId])).rows[0].body as string;
  return insert(p, 'course_flags', {
    reporter_id: reporterId, course_id: c.courseId, version_id: c.versionId, target_type: 'chapter', target_id: chapterId, reason: opts.reason ?? 'inaccurate', snapshot: text, created_at: opts.createdAt ?? NOW,
  });
}

/**
 * A published list course: the same shared course as publishedCourse, turned into a list course. It has no sections or chapters; each of its concepts has a display
 * name, a position, links (the first concept's first link is a vetted library source) and a rating stored with them.
 */
export async function publishedListCourse(p: pg.Pool, opts: { concepts?: number; roleName?: string } = {}) {
  const n = opts.concepts ?? 4;
  const base = await publishedCourse(p, { sections: 1, chaptersPerSection: Math.ceil(n / 2), roleName: opts.roleName });
  await p.query(`DELETE FROM course_sections WHERE course_id = $1`, [base.courseId]);
  await p.query(`UPDATE courses SET mode = 'list' WHERE id = $1`, [base.courseId]);
  const ids = base.conceptIds.slice(0, n);
  await p.query(`DELETE FROM course_concepts WHERE course_id = $1 AND concept_id <> ALL($2)`, [base.courseId, ids]);
  for (const [i, id] of ids.entries()) {
    const links = i === 0 ? [{ lib: 'lib-one' }, { lib: null }] : i === 1 ? [{ lib: null }] : [];
    for (const [j, l] of links.entries()) {
      await p.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [base.courseId, base.versionId, id, j, l.lib ? 'article' : 'blog', `Link ${i}.${j}`, 'Example Press', `https://links.example.org/${i}/${j}`, 'a clear explanation', l.lib]);
    }
    const lib = links.filter((l) => l.lib).length;
    const band = lib >= 1 && links.length >= 2 ? 'strong' : links.length ? 'thin' : 'missing';
    await p.query(`INSERT INTO list_concepts (course_id, version_id, concept_id, position, display_name, band, library_links, other_links) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [base.courseId, base.versionId, id, i, `Display ${i}`, band, lib, links.length - lib]);
  }
  return { ...base, conceptIds: ids };
}
