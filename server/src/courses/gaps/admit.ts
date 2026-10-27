// Admission. A page the finder proposed is added to the library only if it passes the full screen a second time, independently of the first. It is then
// written through saveSource, so each one is one library change and one library version, and the coverage engine rates the new version straight away.
// Nothing here searches or spends a credit. A gap is marked filled by reconcileGaps from the stored rating, never because a page was found.
import type pg from 'pg';
import type { Chat } from '../../llm.ts';
import { MIN_HITS, rateSourceText, refreshCoverage, type CoverageResult, type Reader } from '../coverage/coverage.ts';
import { libraryVersion, saveSource, setSourceStatus } from '../library/db.ts';
import type { LibrarySource } from '../library/load.ts';
import { refreshListCourses } from '../listRefresh.ts';
import { loadTaxonomyFromDb } from '../taxonomy/db.ts';
import { normUrl, screenPage } from './finder.ts';
import { reconcileGaps } from './gaps.ts';

export interface AdmitDeps { pool: pg.Pool; chat: Chat; read: Reader; now?: () => Date }
export interface Admission { admitted: string[]; kept: Array<{ url: string; category: string; reason: string }>; rejected: Array<{ url: string; category: string; reason: string }>; version: { before: number; after: number } }

export async function admitCandidates(deps: AdmitDeps, slug: string): Promise<Admission> {
  const { pool, chat, read } = deps;
  const now = deps.now ?? (() => new Date());
  const tax = await loadTaxonomyFromDb(pool, slug);
  if (!tax) throw new Error(`no taxonomy for ${slug}`);
  const before = await libraryVersion(pool);
  const rows = (await pool.query(`SELECT id, category_id, url, name, draft, checks FROM library_candidates WHERE role_slug = $1 AND status = 'proposed' AND draft IS NOT NULL ORDER BY category_id, id`, [slug])).rows;
  const known = new Set((await pool.query(`SELECT url FROM library_sources`)).rows.map((r) => normUrl(r.url)));
  const ids = new Set((await pool.query(`SELECT id FROM library_sources`)).rows.map((r) => r.id as string));
  const out: Admission = { admitted: [], kept: [], rejected: [], version: { before, after: before } };
  const keep = async (row: { id: number; category_id: string; url: string; checks: object }, reason: string, second: object = {}) => {
    out.kept.push({ url: row.url, category: row.category_id, reason });
    await pool.query(`UPDATE library_candidates SET reason = $2, checks = $3::jsonb WHERE id = $1`, [row.id, reason, JSON.stringify({ ...row.checks, second })]);
  };
  for (const row of rows) {
    const cat = tax.categories.find((c) => c.id === row.category_id);
    if (!cat) { await keep(row, 'failed the second run: the category no longer exists'); continue; }
    const second = await screenPage({ chat, read }, { role: tax.role, cat, known }, { url: row.url, title: row.name });
    if (!second.ok) { await keep(row, `failed the second run: ${second.reason}`, { pass: false, ...second.checks }); continue; }
    const draft = row.draft as LibrarySource;
    if (ids.has(draft.id)) { await keep(row, `failed the second run: the id ${draft.id} is taken`); continue; }
    // The gate: judge the page exactly as the coverage engine will once it is in the library. Only a page the rating would count is admitted.
    const gate = (await rateSourceText(chat, { name: draft.name, why: draft.rationale }, second.opened.text, tax.categories, MIN_HITS)).get(cat.id)?.verdict ?? 'unchecked';
    if (gate === 'mentions') {
      const reason = 'failed the coverage check: the rating would call it only a mention';
      out.rejected.push({ url: row.url, category: row.category_id, reason });
      await pool.query(`UPDATE library_candidates SET status = 'rejected', reason = $2, checks = $3::jsonb WHERE id = $1`, [row.id, reason, JSON.stringify({ ...row.checks, second: { pass: true, hits: second.check.hits }, gate })]);
      continue;
    }
    if (gate !== 'teaches') { await keep(row, 'the coverage check could not be completed, so it was not admitted'); continue; }
    const today = now().toISOString().slice(0, 10);
    const entry: LibrarySource = {
      ...draft,
      last_verified: { ...draft.last_verified, date: today, how: 'opened by the source finder without credentials on two independent runs; page text read' },
      decision_note: `${draft.decision_note} Confirmed on two independent runs (the second on ${today}); admitted automatically (tier ${draft.tier}), with the reader flag as the safety net.`,
    };
    try {
      await saveSource(pool, entry, slug, 'finder');
    } catch (error) {
      await keep(row, `the entry could not be saved: ${(error as Error).message}`);
      continue;
    }
    ids.add(entry.id);
    known.add(normUrl(entry.url));
    out.admitted.push(entry.id);
    await pool.query(`UPDATE library_candidates SET status = 'admitted', reason = 'passed the full screen on two independent runs', admitted_version = $2, checks = $3::jsonb WHERE id = $1`, [row.id, await libraryVersion(pool), JSON.stringify({ ...row.checks, second: { pass: true, hits: second.check.hits, evidence: second.check.evidence } })]);
  }
  out.version.after = await libraryVersion(pool);
  return out;
}

export type ListsRefreshed = { courses: number; notified: number; errors: number };
/** Tell the role's list courses what the library change means for them. It never fails the step that called it: an error is counted and left for the next run. */
async function refreshLists(deps: AdmitDeps, slug: string): Promise<ListsRefreshed> {
  try {
    return await refreshListCourses({ pool: deps.pool, chat: deps.chat, read: deps.read, now: deps.now }, slug);
  } catch {
    return { courses: 0, notified: 0, errors: 1 };
  }
}

/** Admit, then rate the new library version at once (reading and judging the new sources), then bring the gap queue in line with that stored rating, then refresh the role's list courses. */
export async function admitAndRate(deps: AdmitDeps, slug: string): Promise<{ admission: Admission; coverage: CoverageResult; lists: ListsRefreshed }> {
  const admission = await admitCandidates(deps, slug);
  const coverage = await refreshCoverage(deps.pool, slug, deps.read, deps.chat);
  if (coverage.ok) await reconcileGaps(deps.pool, slug);
  const lists = await refreshLists(deps, slug);
  return { admission, coverage, lists };
}

/**
 * Apply the same gate to sources the finder already admitted. A source is removed when the rating does not count it: its stored verdict for the category it
 * was admitted for is "mentions", or judging it afresh gives "mentions". A question that cannot be answered removes nothing. Removal is a status change
 * (one library change each), so the source and its history stay in the database; its candidate is recorded as rejected.
 */
export async function auditAdmitted(deps: AdmitDeps, slug: string): Promise<{ removed: Array<{ id: string; category: string; reason: string }> }> {
  const { pool, chat, read } = deps;
  const tax = await loadTaxonomyFromDb(pool, slug);
  if (!tax) throw new Error(`no taxonomy for ${slug}`);
  const admitted = (await pool.query(
    `SELECT s.id, s.url, s.pipeline_readable, s.name, s.entry->>'rationale' AS why, c.id AS cand, c.category_id FROM library_sources s JOIN library_candidates c ON c.status = 'admitted' AND c.draft->>'id' = s.id AND c.role_slug = $1
     WHERE s.origin = 'finder' AND s.status = 'active' AND $1 = ANY (s.applies_to) ORDER BY s.id`, [slug])).rows;
  const removed: Array<{ id: string; category: string; reason: string }> = [];
  for (const s of admitted) {
    const cat = tax.categories.find((c) => c.id === s.category_id);
    if (!cat) continue;
    const stored = (await pool.query(`SELECT verdict FROM library_source_categories WHERE source_id = $1 AND role_slug = $2 AND category_id = $3`, [s.id, slug, s.category_id])).rows[0]?.verdict as string | undefined;
    let fresh: string = 'unchecked';
    const text = await read({ id: s.id, url: s.url, pipeline_readable: s.pipeline_readable });
    if (text.ok) fresh = (await rateSourceText(chat, { name: s.name, why: s.why ?? '' }, text.text, tax.categories, MIN_HITS)).get(s.category_id)?.verdict ?? 'unchecked';
    if (stored !== 'mentions' && fresh !== 'mentions') continue;
    const reason = `failed the coverage check: the rating ${stored === 'mentions' ? 'stored' : 'now gives'} "mentions" for ${cat.name}, so it does not count`;
    await setSourceStatus(pool, s.id, 'removed', reason);
    await pool.query(`UPDATE library_candidates SET status = 'rejected', reason = $2 WHERE id = $1`, [s.cand, reason]);
    removed.push({ id: s.id, category: s.category_id, reason });
  }
  return { removed };
}

/** Audit, then rate the library as it now stands, bring the gap queue in line, and refresh the role's list courses. */
export async function auditAndRate(deps: AdmitDeps, slug: string): Promise<{ removed: Array<{ id: string; category: string; reason: string }>; coverage: CoverageResult; lists: ListsRefreshed }> {
  const { removed } = await auditAdmitted(deps, slug);
  const coverage = await refreshCoverage(deps.pool, slug, deps.read, deps.chat);
  if (coverage.ok) await reconcileGaps(deps.pool, slug);
  const lists = await refreshLists(deps, slug);
  return { removed, coverage, lists };
}
