// The shared record of judged pages (link_judgments) is tied to no reader and survives list and account deletion, so only names that are shared concepts or standard
// skill categories may be written to it. A concept that exists only because of one reader's posting is judged, but its verdicts stay in memory for that one build.
// Real SQL, fake model.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { account, course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { createSources } from '../sources.ts';
import { buildCourse } from './build.ts';
import { importTaxonomy } from '../taxonomy/db.ts';
import type { Taxonomy } from '../taxonomy/taxonomy.ts';
import { requeueBuild } from './requeue.ts';

const { db } = useCourseDb('judgpriv', { reset: ['roles', 'accounts', 'skill_taxonomies', 'skill_categories', 'link_judgments'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const MARKET = (i: number) => ['sql', ...(i < 6 ? ['debugging'] : []), ...(i < 3 ? ['python'] : [])];

/** The role, its nine market postings and the reader; lists are added to it one at a time. */
async function world(p: pg.Pool) {
  const owner = await account(p);
  const roleId = await role(p, 'backend engineer', 'Builds and runs services.');
  const sourceIds: string[] = [];
  const urls: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await source(p, roleId, { status: 'current' });
    sourceIds.push(id);
    urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
  }
  return { owner, roleId, sourceIds, urls };
}
/** One private list of the reader's: approved, with its own pasted description registered as its own source and a build queued. */
async function list(p: pg.Pool, w: Awaited<ReturnType<typeof world>>, pasted: string, independent: boolean) {
  const courseId = await course(p, w.roleId, { status: 'building', approved_at: NOW, title: 'backend engineer', visibility: 'private', owner_account_id: w.owner, requested_by: w.owner, independent, mode: 'list' });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  for (const id of w.sourceIds) await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
  await p.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'backend engineer', $3, $4)`, [w.owner, courseId, pasted, NOW]);
  const paste = await createSources(p, () => NOW).registerPaste(w.roleId, w.owner, { roleTitle: 'backend engineer' });
  await createSources(p, () => NOW).attach(courseId, paste, 'reader');
  await p.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND source_id = $2`, [courseId, paste]);
  return { courseId, versionId, paste };
}

/** The judge's questions, as the model saw them: which skill, which page. */
type Asked = { skill: string; url: string };
function deps(p: pg.Pool, urls: string[], over: Record<string, unknown> = {}, extra: { mapAnswers?: Record<string, { category: string }> } = {}) {
  const asked: Asked[] = [];
  const model = fakeModel({
    ...(extra.mapAnswers ? { mapAnswers: extra.mapAnswers } : {}),
    override: (label, m) => {
      if (label === 'page') {
        const x = /Skill: (.*)\n<page>\n(\S+)\n/.exec(m.at(-1)!.content);
        if (x) asked.push({ skill: x[1]!, url: x[2]! });
      }
      return undefined;
    },
  });
  return { asked, d: { pool: p, chat: model, search: fakeSearch(), extract: fakeExtract(Object.fromEntries(urls.map((u, i) => [u, postingText(MARKET(i), [])]))), youtube: fakeYoutube(), reachable: async () => true, readPage: async () => ({ ok: true as const, text: 'A page that explains the idea in plain words, at some length, for people doing the work. '.repeat(10) }), now: () => NOW, ...over } };
}
const rows = async (p: pg.Pool) => (await p.query(`SELECT concept, judge FROM link_judgments ORDER BY concept, judge`)).rows as Array<{ concept: string; judge: string }>;
const PRIVATE = ['tableau', 'requirements analysis'];
async function again(p: pg.Pool, courseId: string) {
  await p.query(`UPDATE courses SET status = 'failed', published_version = NULL WHERE id = $1`, [courseId]);
  await p.query(`UPDATE course_versions SET status = 'failed' WHERE course_id = $1`, [courseId]);
  await requeueBuild(p, courseId, () => NOW);
}

db('a phrase that exists only because of one reader\'s posting is judged, but nothing about it is written to the shared record', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['sql', 'tableau', 'requirements analysis'], []), true);
  const x = deps(p, w.urls);
  assert.equal((await buildCourse(x.d, one.courseId)).ok, true);
  for (const skill of PRIVATE) assert.ok(x.asked.some((a) => a.skill === skill), `${skill} was judged against real pages`);
  assert.deepEqual((await rows(p)).filter((r) => PRIVATE.includes(r.concept)), [], 'no row for a reader-only phrase');
  const privateNames = (await p.query(`SELECT name FROM role_concepts WHERE visibility = 'private' ORDER BY name`)).rows.map((r) => r.name);
  assert.ok(PRIVATE.every((n) => privateNames.includes(n)), 'they are private concepts of the list');
});

db('a shared concept still writes its verdicts, and a second build reuses them while a reader-only phrase is judged again', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['sql', 'tableau'], []), true);
  const first = deps(p, w.urls);
  assert.equal((await buildCourse(first.d, one.courseId)).ok, true);
  const written = (await rows(p)).map((r) => r.concept);
  assert.ok(written.includes('sql') && written.includes('debugging'), `shared concepts are written: ${[...new Set(written)]}`);
  assert.ok(written.every((n) => !PRIVATE.includes(n)));
  await again(p, one.courseId);
  const second = deps(p, w.urls);
  assert.equal((await buildCourse(second.d, one.courseId)).ok, true);
  assert.deepEqual(second.asked.filter((a) => a.skill === 'sql' || a.skill === 'debugging'), [], 'shared concepts were not judged again');
  assert.ok(second.asked.some((a) => a.skill === 'tableau'), 'a reader-only phrase has no stored verdicts, so it is judged again');
});

db('within one build a reader-only concept\'s page is judged once, even when the same page comes back', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['sql', 'tableau'], []), true);
  // No page opens, so every concept is short of links and searches again for more: the same pages return to be judged.
  const x = deps(p, w.urls, { reachable: async () => false });
  assert.equal((await buildCourse(x.d, one.courseId)).ok, true);
  const mine = x.asked.filter((a) => a.skill === 'tableau');
  assert.ok(mine.length >= 2, 'it was judged against pages');
  assert.equal(new Set(mine.map((a) => a.url)).size, mine.length, 'no page was judged twice for it in the build');
  assert.deepEqual((await rows(p)).filter((r) => r.concept === 'tableau'), []);
});

const TAX: Taxonomy = {
  role: 'backend engineer',
  categories: [{ id: 'compliance-controls', name: 'Compliance, controls and risk', description: 'internal controls, audit and regulatory compliance', aliases: [] }],
  tools: [],
};
db('a reader\'s phrase folded into a standard skill is written under the standard name, never under the phrase', async (p) => {
  const w = await world(p);
  await importTaxonomy(p, 'backend-engineer', TAX);
  const one = await list(p, w, postingText(['sox controls documentation', 'document controls for sox compliance'], []), true);
  const x = deps(p, w.urls, {}, { mapAnswers: { 'sox controls documentation': { category: 'compliance-controls' }, 'document controls for sox compliance': { category: 'compliance-controls' } } });
  assert.equal((await buildCourse(x.d, one.courseId)).ok, true);
  const written = (await rows(p)).map((r) => r.concept);
  assert.ok(written.includes('compliance, controls and risk'), `the standard name is written: ${[...new Set(written)]}`);
  assert.ok(!written.includes('sox controls documentation') && !written.includes('document controls for sox compliance'), 'the posting\'s own wording is not');
});

db('a reader\'s wording merged with a public skill never reaches the shared row: the throwaway case, "writing sql queries", leaves only the public wording', async (p) => {
  const w = await world(p);
  const one = await list(p, w, postingText(['writing sql queries', 'tableau'], []), true);
  const x = deps(p, w.urls);
  (x.d as { chat: unknown }).chat = fakeModel({ override: (label) => (label === 'merge' ? JSON.stringify({ groups: [{ name: 'writing sql queries', variants: ['sql'] }] }) : undefined) });
  assert.equal((await buildCourse(x.d as never, one.courseId)).ok, true);
  const shared = (await p.query(`SELECT name, terms, mentions FROM role_concepts WHERE visibility = 'shared' ORDER BY name`)).rows;
  assert.deepEqual(shared.map((r) => r.name), ['debugging', 'python', 'sql'], 'the shared concept has the public name');
  assert.deepEqual(shared.find((r) => r.name === 'sql')!.terms, ['sql'], 'and only the public wording');
  assert.equal(shared.find((r) => r.name === 'sql')!.mentions, 9);
  assert.equal(JSON.stringify(shared).includes('writing sql queries'), false, 'the reader\'s phrase is nowhere on a shared row');
  const mine = (await p.query(`SELECT k.name, k.visibility FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY k.name`, [one.courseId])).rows;
  assert.ok(mine.some((r) => r.name === 'sql' && r.visibility === 'shared'), 'the reader\'s list still has the skill');
  assert.ok(mine.some((r) => r.name === 'tableau' && r.visibility === 'private'), 'a reader-only skill is still private');
  const linked = (await p.query(`SELECT count(*)::int AS n FROM source_skills ss JOIN role_concepts k ON k.id = ss.concept_id WHERE ss.source_id = $1 AND k.name = 'sql'`, [one.paste])).rows[0].n;
  assert.equal(linked, 1, 'the reader\'s posting still counts as asking for the skill, under the public name');
});

