import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';
import { requeueBuild } from './requeue.ts';

const { db } = useCourseDb('build', { reset: ['roles', 'accounts'] });
const NOW = new Date('2026-10-20T12:00:00Z');

/** A course that has been approved: building, with a queued run, a building version and its sources in the pool. */
async function approvedCourse(p: import('pg').Pool, n = 9, roleName = 'backend engineer') {
  const roleId = await role(p, roleName, 'Builds and runs services.');
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: roleName });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await source(p, roleId, { status: 'current' });
    await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { roleId, courseId, versionId, runId, urls };
}
const SKILLS = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['python'] : []), ...(i < 2 ? ['caching'] : []), ...(i === 0 ? ['once only'] : [])];
const SCENARIOS = (i: number) => [...(i < 5 ? ['handle an outage'] : []), ...(i < 3 ? ['review a design'] : [])];
const texts = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, postingText(SKILLS(i), SCENARIOS(i))]));
const deps = (p: import('pg').Pool, urls: string[], chat = fakeModel(), over: Record<string, unknown> = {}) => ({ pool: p, chat, search: fakeSearch(), extract: fakeExtract(texts(urls)), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW, ...over });

db('an approved course is built and published: concepts ranked, resources and facts stored, cards, story, chapters, quizzes, one live version', async (p) => {
  const c = await approvedCourse(p);
  const r = await buildCourse(deps(p, c.urls), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const course_ = (await p.query(`SELECT status, published_version, pool_size FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([course_.status, course_.published_version, course_.pool_size], ['ready', c.versionId, 9]);

  const concepts = (await p.query(`SELECT name, kind, mentions, criticality FROM role_concepts WHERE role_id = $1 ORDER BY kind, mentions DESC, name`, [c.roleId])).rows;
  assert.deepEqual(concepts.map((x) => [x.kind, x.name, x.mentions, x.criticality]), [
    ['scenario', 'handle an outage', 5, 'medium'], ['scenario', 'review a design', 3, 'medium'],
    ['skill', 'sql', 9, 'high'], ['skill', 'debugging', 6, 'high'], ['skill', 'python', 3, 'medium'], ['skill', 'caching', 2, 'low'],
  ]); // "once only" is dropped (one mention)

  // every concept is taught in exactly one chapter, in cards of two or three
  const taught = (await p.query(`SELECT cc.concept_id, count(*)::int AS n FROM chapter_concepts cc JOIN course_chapters ch ON ch.id = cc.chapter_id JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = $1 GROUP BY 1`, [c.courseId])).rows;
  assert.equal(taught.length, 6);
  assert.ok(taught.every((t) => t.n === 1));
  const sizes = (await p.query(`SELECT count(*)::int AS n FROM chapter_concepts cc JOIN course_chapters ch ON ch.id = cc.chapter_id JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = $1 GROUP BY ch.id`, [c.courseId])).rows;
  assert.ok(sizes.every((s) => s.n >= 2 && s.n <= 3));

  const chapters = (await p.query(`SELECT t.title, t.body FROM chapter_texts t WHERE t.version_id = $1`, [c.versionId])).rows;
  assert.equal(chapters.length, sizes.length);
  assert.ok(chapters.every((t) => t.body.split(/\s+/).length >= 150 && t.body.split(/\s+/).length <= 250));
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM story_bible WHERE course_id = $1 AND version_id = $2`, [c.courseId, c.versionId])).rows[0].n, 1);
  const quizzes = (await p.query(`SELECT verified_at FROM section_quizzes WHERE version_id = $1`, [c.versionId])).rows;
  assert.ok(quizzes.length >= 1 && quizzes.every((q) => q.verified_at));

  // reference: two to four resources per concept; facts are in the ledger with their source
  const perConcept = (await p.query(`SELECT count(*)::int AS n FROM resources r JOIN role_concepts k ON k.id = r.concept_id WHERE k.role_id = $1 GROUP BY r.concept_id`, [c.roleId])).rows;
  assert.ok(perConcept.length === 6 && perConcept.every((x) => x.n >= 2 && x.n <= 4));
  assert.ok((await p.query(`SELECT count(*)::int AS n FROM concept_claims k JOIN role_concepts rc ON rc.id = k.concept_id WHERE rc.role_id = $1 AND k.source_url IS NOT NULL`, [c.roleId])).rows[0].n > 0);

  // the run is the one approval queued, finished, with its cost
  const run = (await p.query(`SELECT stage, percent, tavily_credits, error, finished_at FROM course_runs WHERE id = $1`, [c.runId])).rows[0];
  assert.deepEqual([run.stage, run.percent, run.error], ['publish', 100, null]);
  assert.ok(run.tavily_credits >= 2 && run.finished_at);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM course_runs WHERE course_id = $1`, [c.courseId])).rows[0].n, 1);
});

db('nothing is built for a course that was not approved, and no model is called', async (p) => {
  const c = await approvedCourse(p);
  await p.query(`UPDATE courses SET status = 'awaiting_approval', approved_at = NULL WHERE id = $1`, [c.courseId]);
  const chat = fakeModel();
  await assert.rejects(buildCourse(deps(p, c.urls, chat), c.courseId), /not approved|not building/i);
  assert.deepEqual(chat.labels, []);
});

db('postings that are not US postings are dropped, and fewer than eight left ends the build failed with not_enough_postings', async (p) => {
  const c = await approvedCourse(p, 9);
  const t = texts(c.urls);
  for (const u of c.urls.slice(0, 2)) t[u] += ' NOT-US';
  const r = await buildCourse(deps(p, c.urls, fakeModel(), { extract: fakeExtract(t) }), c.courseId);
  assert.equal(r.ok, false);
  const row = (await p.query(`SELECT status, failure_reason, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([row.status, row.failure_reason, row.published_version], ['failed', 'not_enough_postings', null]);
  assert.equal((await p.query(`SELECT status FROM course_versions WHERE id = $1`, [c.versionId])).rows[0].status, 'failed');
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM sources WHERE role_id = $1 AND status = 'dropped'`, [c.roleId])).rows[0].n, 2);
});

db('a QA flag on a law claim that survives the rewrite fails the build with qa_failed and publishes nothing', async (p) => {
  const c = await approvedCourse(p);
  const chat = fakeModel({
    override: (label, m) => {
      if (label !== 'qa') return undefined;
      const chapter = /<chapter>\n([\s\S]*)\n<\/chapter>/.exec(m.at(-1)!.content)![1]!;
      return JSON.stringify({ claims: [{ text: chapter.split('. ')[0]!, verdict: 'unsupported', category: 'law', quote: '' }] });
    },
  });
  const r = await buildCourse(deps(p, c.urls, chat), c.courseId);
  assert.equal(r.ok, false);
  const row = (await p.query(`SELECT status, failure_reason, published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0];
  assert.deepEqual([row.status, row.failure_reason, row.published_version], ['failed', 'qa_failed', null]);
  assert.match((await p.query(`SELECT error FROM course_runs WHERE id = $1`, [c.runId])).rows[0].error, /qa_failed/);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM chapter_texts WHERE version_id = $1`, [c.versionId])).rows[0].n, 0); // nothing half-built is stored for readers
  assert.equal(chat.labels.filter((l) => l === 'write').length > chat.labels.filter((l) => l === 'qa').length / 2, true); // the chapter was rewritten before it failed
});

db('a chapter with an ordinary flagged claim is rewritten once and then passes', async (p) => {
  const c = await approvedCourse(p);
  let first = true;
  const chat = fakeModel({
    override: (label, m) => {
      if (label !== 'qa') return undefined;
      const chapter = /<chapter>\n([\s\S]*)\n<\/chapter>/.exec(m.at(-1)!.content)![1]!;
      const text = chapter.split('. ')[0]!;
      const verdict = first ? 'unsupported' : 'supported';
      first = false;
      return JSON.stringify({ claims: [{ text, verdict, category: null, quote: '' }, ...Array.from({ length: 9 }, (_, i) => ({ text: `claim ${i} is fine`, verdict: 'supported', category: null, quote: '' }))] });
    },
  });
  const r = await buildCourse(deps(p, c.urls, chat), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [c.courseId])).rows[0].status, 'ready');
});

db('the scope check fails a chapter that mentions a personal characteristic: rewritten once, then the build fails', async (p) => {
  const c = await approvedCourse(p);
  const chat = fakeModel({ override: (label) => (label === 'write' ? `Sam, a young woman from Lagos, ${'detail '.repeat(170)} sql debugging python caching handle an outage review a design` : undefined) });
  const r = await buildCourse(deps(p, c.urls, chat), c.courseId);
  assert.equal(r.ok, false);
  assert.equal((await p.query(`SELECT failure_reason FROM courses WHERE id = $1`, [c.courseId])).rows[0].failure_reason, 'qa_failed');
});

db('a role reuses what any published course covers, with no role chosen first: its facts and resources are carried over, its own reference research runs only for the rest', async (p) => {
  const a = await approvedCourse(p, 9, 'backend engineer');
  const searchA = fakeSearch();
  assert.equal((await buildCourse(deps(p, a.urls, fakeModel(), { search: searchA }), a.courseId)).ok, true);
  const aConcepts = new Map((await p.query(`SELECT name, id FROM role_concepts WHERE role_id = $1`, [a.roleId])).rows.map((r) => [r.name as string, r.id as string]));

  const b = await approvedCourse(p, 9, 'platform engineer');
  const tb: Record<string, string> = {};
  b.urls.forEach((u, i) => (tb[u] = postingText(['sql', 'debugging', ...(i < 5 ? ['kubernetes'] : [])], i < 4 ? ['handle an outage'] : [])));
  const searchB = fakeSearch();
  const chat = fakeModel({
    override: (label, m) => {
      if (label === 'delta') {
        const asked = (JSON.parse(m.at(-1)!.content) as { requirements: string[] }).requirements;
        return JSON.stringify({ results: asked.map((name) => (aConcepts.has(name) ? { name, class: 'covered', match: aConcepts.get(name) } : { name, class: 'new' })) });
      }
      return undefined;
    },
  });
  const r = await buildCourse(deps(p, b.urls, chat, { search: searchB, extract: fakeExtract(tb) }), b.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));

  const reuse = (await p.query(`SELECT k.name, cr.kind, k.derived_from FROM course_reuse cr JOIN role_concepts k ON k.id = cr.concept_id WHERE cr.course_id = $1 ORDER BY k.name`, [b.courseId])).rows;
  assert.deepEqual(reuse.map((x) => [x.name, x.kind]), [['debugging', 'covered'], ['handle an outage', 'covered'], ['kubernetes', 'new'], ['sql', 'covered']]);
  assert.ok(reuse.filter((x) => x.kind === 'covered').every((x) => x.derived_from));
  // reference research ran for the one new concept only (one search, or two when a second publisher was needed)
  assert.ok(searchB.calls >= 1 && searchB.calls <= 2, `searches for the new concept only, got ${searchB.calls}`);
  assert.ok(searchA.calls >= 6 && searchA.calls > searchB.calls * 3);
  // the covered concepts arrived with their stored resources and facts
  const bSql = (await p.query(`SELECT id FROM role_concepts WHERE role_id = $1 AND name = 'sql'`, [b.roleId])).rows[0].id;
  assert.ok((await p.query(`SELECT count(*)::int AS n FROM resources WHERE concept_id = $1`, [bSql])).rows[0].n >= 2);
  assert.ok((await p.query(`SELECT count(*)::int AS n FROM concept_claims WHERE concept_id = $1`, [bSql])).rows[0].n >= 1);
  // each course still has its own text: nothing was copied from the other course
  const text = (id: string) => p.query(`SELECT body FROM chapter_texts WHERE version_id = $1 ORDER BY body`, [id]).then((r) => r.rows.map((x) => x.body as string));
  const [ta, tb2] = [await text(a.versionId), await text(b.versionId)];
  assert.ok(ta.length > 0 && tb2.length > 0 && ta.every((x) => !tb2.includes(x)));
  assert.equal((await p.query(`SELECT status FROM courses WHERE id = $1`, [b.courseId])).rows[0].status, 'ready');
});

db('a failed build can be queued again, and the second build does not repeat reference research that is already stored', async (p) => {
  const c = await approvedCourse(p);
  const searchFirst = fakeSearch();
  const broken = fakeModel({ override: (label) => (label === 'write' ? 'too short' : undefined) });
  const first = await buildCourse(deps(p, c.urls, broken, { search: searchFirst }), c.courseId);
  assert.equal(first.ok, false);
  assert.equal(first.ok === false && first.stage, 'write');
  assert.ok(searchFirst.calls >= 6);

  const queued = await requeueBuild(p, c.courseId, () => NOW);
  assert.notEqual(queued.versionId, c.versionId);
  assert.equal((await p.query(`SELECT status, failure_reason FROM courses WHERE id = $1`, [c.courseId])).rows[0].status, 'building');
  const searchSecond = fakeSearch();
  const qaSources: string[] = [];
  const second = await buildCourse(deps(p, c.urls, fakeModel({ override: (label, m) => (label === 'qa' ? (qaSources.push(/<sources>([\s\S]*)<\/sources>/.exec(m.at(-1)!.content)![1]!), undefined) : undefined) }), { search: searchSecond }), c.courseId);
  assert.ok(qaSources.length > 0 && qaSources.every((x) => /is how the work gets done in practice/.test(x)), 'the QA agent is shown the stored facts as its sources when the pages are gone');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(searchSecond.calls, 0, 'nothing researched again');
  assert.equal((await p.query(`SELECT published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0].published_version, queued.versionId);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM course_chapters ch JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = $1`, [c.courseId])).rows[0].n > 0, true);
});

db('only a failed course that was approved can be queued again', async (p) => {
  const c = await approvedCourse(p);
  await assert.rejects(requeueBuild(p, c.courseId, () => NOW), /failed/i); // it is building, not failed
  const fresh = await course(p, await role(p), { status: 'awaiting_approval' });
  await assert.rejects(requeueBuild(p, fresh, () => NOW), /approved|failed/i);
});

db('written chapters are saved as they are produced: a build queued again after a check failure reuses the plan and the text and writes nothing', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const c = await approvedCourse(p);
  const firstLabels: string[] = [];
  const first = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (firstLabels.push(label), label === 'qa' ? 'not json' : undefined) }), { snapshotDir: dir }), c.courseId);
  assert.ok(firstLabels.includes('merge'), 'the first build ranked the concepts');
  assert.equal(first.ok === false && first.stage, 'check');
  assert.ok(existsSync(join(dir, `${c.courseId}.json`)));
  await requeueBuild(p, c.courseId, () => NOW);
  const labels: string[] = [];
  const second = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (labels.push(label), undefined) }), { snapshotDir: dir }), c.courseId);
  assert.equal(second.ok, true, JSON.stringify(second));
  for (const l of ['write', 'story', 'stages', 'coherence', 'merge']) assert.ok(!labels.includes(l), `${l} was not called again (the ranking is kept with the plan)`);
  assert.ok(labels.includes('qa'));
  assert.ok(!existsSync(join(dir, `${c.courseId}.json`)), 'the snapshot goes once the course is published');
});

db('a saved chapter set with one text emptied writes only that chapter, keeps the rest, and still checks and publishes everything', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const c = await approvedCourse(p);
  const first = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (label === 'qa' ? 'not json' : undefined) }), { snapshotDir: dir }), c.courseId);
  assert.equal(first.ok === false && first.stage, 'check');
  const file = join(dir, `${c.courseId}.json`);
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const kept = snap.bodies.map((b: string) => b);
  assert.ok(kept.length >= 2);
  snap.bodies[1] = null; // the one text to write again
  delete snap.checked;
  writeFileSync(file, JSON.stringify(snap));
  await requeueBuild(p, c.courseId, () => NOW);
  const labels: string[] = [];
  const second = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (labels.push(label), undefined) }), { snapshotDir: dir }), c.courseId);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(labels.filter((l) => l === 'write').length, 1, 'one chapter was written');
  assert.ok(labels.includes('qa') && labels.includes('quiz'), 'everything is checked again and the quizzes are made');
  const texts = (await p.query(`SELECT t.body FROM chapter_texts t JOIN course_chapters ch ON ch.id = t.chapter_id JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = $1 ORDER BY s.position, ch.position`, [c.courseId])).rows.map((r) => r.body);
  assert.equal(texts.length, kept.length);
  for (const [i, b] of kept.entries()) if (i !== 1) assert.equal(texts[i], b, `chapter ${i} is the text that was kept`);
});

db('every chapter\'s full claim list is reported as it is checked', async (p) => {
  const c = await approvedCourse(p);
  const seen: Array<{ chapter: string; round: string; claims: number; flagged: number }> = [];
  const r = await buildCourse(deps(p, c.urls, fakeModel(), { onClaims: (x: (typeof seen)[number]) => seen.push(x) }), c.courseId);
  assert.equal(r.ok, true);
  assert.ok(seen.length > 0 && seen.every((x) => x.claims > 0 && x.round === 'first' && x.flagged === 0 && x.chapter));
});

db('a build told not to research uses what is stored and searches nothing, even for a concept with too few resources', async (p) => {
  const c = await approvedCourse(p);
  const first = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (label === 'write' ? 'too short' : undefined) })), c.courseId);
  assert.equal(first.ok === false && first.stage, 'write');
  await p.query(`DELETE FROM resources WHERE concept_id IN (SELECT id FROM role_concepts WHERE name = 'caching')`); // left with nothing, so a normal rebuild would search again
  await requeueBuild(p, c.courseId, () => NOW);
  const search = fakeSearch();
  const second = await buildCourse(deps(p, c.urls, fakeModel(), { search, noResearch: true }), c.courseId);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(search.calls, 0);
});

db('a rewritten chapter is saved in the snapshot, so a build that fails after the rewrite keeps the text it failed on', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const c = await approvedCourse(p);
  const chat = fakeModel({
    override: (label, m) => {
      if (label === 'write' && /A check on the earlier version failed/.test(m.at(-1)!.content)) {
        const names = [...m.at(-1)!.content.matchAll(/^- (.+?)$/gm)].map((x) => x[1]!);
        return `Sam started the day with ${names.join(' and ')} in mind. REWRITTEN ${Array.from({ length: 170 }, (_, i) => `detail${i % 9}`).join(' ')} Then Sam wrote down what worked.`;
      }
      if (label !== 'qa') return undefined;
      const chapter = /<chapter>\n([\s\S]*)\n<\/chapter>/.exec(m.at(-1)!.content)![1]!;
      return JSON.stringify({ claims: [{ text: chapter.split('. ')[0]!, verdict: 'unsupported', category: 'law', quote: '' }] });
    },
  });
  const r = await buildCourse(deps(p, c.urls, chat, { snapshotDir: dir }), c.courseId);
  assert.equal(r.ok, false);
  const saved = JSON.parse(readFileSync(join(dir, `${c.courseId}.json`), 'utf8')) as { bodies: string[] };
  assert.match(saved.bodies[0]!, /REWRITTEN/);
});

db('a reuse comparison that fails on a later run keeps the record an earlier run stored, and does not overwrite it with "all related"', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const a = await approvedCourse(p, 9, 'backend engineer');
  assert.equal((await buildCourse(deps(p, a.urls, fakeModel(), { search: fakeSearch() }), a.courseId)).ok, true);
  const aConcepts = new Map((await p.query(`SELECT name, id FROM role_concepts WHERE role_id = $1`, [a.roleId])).rows.map((r) => [r.name as string, r.id as string]));
  const b = await approvedCourse(p, 9, 'platform engineer');
  const tb: Record<string, string> = {};
  b.urls.forEach((u, i) => (tb[u] = postingText(['sql', 'debugging', ...(i < 5 ? ['kubernetes'] : [])], i < 4 ? ['handle an outage'] : [])));
  const covers = (label: string, m: Array<{ content: string }>) => {
    if (label === 'delta') {
      const asked = (JSON.parse(m.at(-1)!.content) as { requirements: string[] }).requirements;
      return JSON.stringify({ results: asked.map((name) => (aConcepts.has(name) ? { name, class: 'covered', match: aConcepts.get(name) } : { name, class: 'new' })) });
    }
    return label === 'qa' ? 'not json' : undefined;
  };
  const first = await buildCourse(deps(p, b.urls, fakeModel({ override: covers }), { search: fakeSearch(), extract: fakeExtract(tb), snapshotDir: dir }), b.courseId);
  assert.equal(first.ok === false && first.stage, 'check');
  const kinds = async () => (await p.query(`SELECT k.name, cr.kind FROM course_reuse cr JOIN role_concepts k ON k.id = cr.concept_id WHERE cr.course_id = $1 ORDER BY k.name`, [b.courseId])).rows.map((x) => [x.name, x.kind]);
  const stored = await kinds();
  assert.ok(stored.some(([, kind]) => kind === 'covered'));
  await requeueBuild(p, b.courseId, () => NOW);
  const second = await buildCourse(deps(p, b.urls, fakeModel({ override: (label) => (label === 'delta' ? 'not json at all' : undefined) }), { search: fakeSearch(), extract: fakeExtract(tb) }), b.courseId); // no snapshot: nothing resumed, so the comparison runs
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(await kinds(), stored, 'the earlier result stands');
  assert.ok(second.notes.some((n) => /comparison failed/.test(n)) && second.notes.some((n) => /earlier run is kept/.test(n)));
});

db('a build resumed from its snapshot keeps the reuse result its chapters were built on, even when the comparison would now answer differently', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const a = await approvedCourse(p, 9, 'backend engineer');
  assert.equal((await buildCourse(deps(p, a.urls, fakeModel(), { search: fakeSearch() }), a.courseId)).ok, true);
  const aConcepts = new Map((await p.query(`SELECT name, id FROM role_concepts WHERE role_id = $1`, [a.roleId])).rows.map((r) => [r.name as string, r.id as string]));
  const b = await approvedCourse(p, 9, 'platform engineer');
  const tb: Record<string, string> = {};
  b.urls.forEach((u, i) => (tb[u] = postingText(['sql', 'debugging', ...(i < 5 ? ['kubernetes'] : [])], i < 4 ? ['handle an outage'] : [])));
  const first = await buildCourse(deps(p, b.urls, fakeModel({
    override: (label, m) => {
      if (label === 'delta') {
        const asked = (JSON.parse(m.at(-1)!.content) as { requirements: string[] }).requirements;
        return JSON.stringify({ results: asked.map((name) => (aConcepts.has(name) ? { name, class: 'covered', match: aConcepts.get(name) } : { name, class: 'new' })) });
      }
      return label === 'qa' ? 'not json' : undefined;
    },
  }), { search: fakeSearch(), extract: fakeExtract(tb), snapshotDir: dir }), b.courseId);
  assert.equal(first.ok === false && first.stage, 'check');
  const kinds = async () => (await p.query(`SELECT k.name, cr.kind FROM course_reuse cr JOIN role_concepts k ON k.id = cr.concept_id WHERE cr.course_id = $1 ORDER BY k.name`, [b.courseId])).rows.map((x) => [x.name, x.kind]);
  const stored = await kinds();
  assert.ok(stored.some(([, kind]) => kind === 'covered'));
  await requeueBuild(p, b.courseId, () => NOW);
  const labels: string[] = [];
  const second = await buildCourse(deps(p, b.urls, fakeModel({ override: (label) => (labels.push(label), label === 'delta' ? JSON.stringify({ results: [] }) : undefined) }), { search: fakeSearch(), extract: fakeExtract(tb), snapshotDir: dir }), b.courseId);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(!labels.includes('delta'), 'the comparison is not run again for a resumed build');
  assert.deepEqual(await kinds(), stored);
});

db('a build resumed after the check passed does not run the check again, and goes straight on to the quiz', async (p) => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const c = await approvedCourse(p);
  const first = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (label === 'quiz' ? 'not json' : undefined) }), { snapshotDir: dir }), c.courseId);
  assert.equal(first.ok === false && first.stage, 'quiz');
  assert.ok(JSON.parse(readFileSync(join(dir, `${c.courseId}.json`), 'utf8')).checked, 'the snapshot records that the check passed');
  await requeueBuild(p, c.courseId, () => NOW);
  const labels: string[] = [];
  const second = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (labels.push(label), undefined) }), { snapshotDir: dir }), c.courseId);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(!labels.includes('qa') && !labels.includes('scope'), 'neither the scope check nor the QA agent ran again');
  assert.ok(labels.includes('quiz'));
});

db('reference research is grounded in the industry of the postings that asked for each concept, not the whole course', async (p) => {
  const c = await approvedCourse(p);
  const base = fakeSearch();
  const queries: string[] = [];
  const search = { search: async (q: Parameters<typeof base.search>[0]) => (queries.push(q.query), base.search(q)) };
  // the fake industry model answers with how many employers it was asked about
  const chat = fakeModel({ override: (_label, m) => (/Name the industry/.test(m[0]!.content) ? JSON.stringify({ industry: `${(JSON.parse(m.at(-1)!.content) as unknown[]).length} employers` }) : undefined) });
  const r = await buildCourse(deps(p, c.urls, chat, { search }), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const about = (concept: string) => queries.filter((q) => q.startsWith(concept));
  assert.ok(about('python').length > 0 && about('python').every((q) => /in 3 employers/.test(q) || /3 employers definition/.test(q)), about('python')[0]);
  assert.ok(about('debugging').every((q) => /6 employers/.test(q)), about('debugging')[0]);
  assert.ok(about('caching').every((q) => /2 employers/.test(q)), about('caching')[0]);
  assert.ok(about('sql').every((q) => /9 employers/.test(q)), about('sql')[0]);
});

db('a story planner that falls back is said so in the run notes, with the reason', async (p) => {
  const c = await approvedCourse(p);
  const r = await buildCourse(deps(p, c.urls, fakeModel({ override: (label) => (label === 'story' ? JSON.stringify({ bible: {}, sections: [] }) : undefined) })), c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.notes.some((n) => /story planner fell back to a generic story/.test(n) && /exactly \d+ sections?/.test(n)), JSON.stringify(r.notes));
});
