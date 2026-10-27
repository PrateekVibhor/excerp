// Plan 16, part 3, step A in the pipeline: an industry chosen for the course is the research hint in place of the pipeline's own guess, a blank one
// keeps the guess, and what is researched is kept per industry so two industries of one role never share or overwrite each other's facts.
import assert from 'node:assert/strict';
import type pg from 'pg';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { course, role, source } from '../../../testkit/courseFixtures.ts';
import { fakeExtract, fakeModel, fakeSearch, fakeYoutube, postingText } from '../../../testkit/fakePipeline.ts';
import { buildCourse } from './build.ts';

const { db } = useCourseDb('industrybuild', { reset: ['roles', 'accounts'] });
const NOW = new Date('2026-10-20T12:00:00Z');
const GUESS = /Name the industry or kind of business/;

/** An approved, building course; pass the role to add a second course (another industry) to it, reusing the role's postings. */
async function approved(p: pg.Pool, industry: string, existingRole?: { roleId: string; sourceIds: string[]; urls: string[] }) {
  const roleId = existingRole?.roleId ?? (await role(p, 'business analyst', 'Works out what a business needs.'));
  const courseId = await course(p, roleId, { status: 'building', approved_at: NOW, title: 'business analyst', industry });
  const versionId = (await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [courseId])).rows[0].id as string;
  const runId = (await p.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, $3) RETURNING id`, [courseId, versionId, NOW])).rows[0].id as number;
  await p.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
  const sourceIds = existingRole?.sourceIds ?? [];
  const urls = existingRole?.urls ?? [];
  if (!existingRole) {
    for (let i = 0; i < 9; i++) {
      const id = await source(p, roleId, { status: 'current' });
      sourceIds.push(id);
      urls.push((await p.query(`SELECT url FROM sources WHERE id = $1`, [id])).rows[0].url);
    }
  }
  for (const id of sourceIds) await p.query(`INSERT INTO course_sources (course_id, source_id, use, state) VALUES ($1, $2, 'pool', 'approved')`, [courseId, id]);
  return { roleId, courseId, versionId, sourceIds, urls };
}
const SKILLS = (i: number) => ['sql', ...(i < 6 ? ['requirements analysis'] : []), ...(i < 3 ? ['process modelling'] : [])];
const texts = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, postingText(SKILLS(i), i < 4 ? ['run a workshop'] : [])]));

/** Dependencies that remember every prompt the model got and every query the search got. */
function watched(p: pg.Pool, urls: string[]) {
  const prompts: string[] = [];
  const queries: string[] = [];
  const search = fakeSearch();
  const inner = search.search.bind(search);
  search.search = async (q) => (queries.push(q.query), inner(q));
  const chat = fakeModel({ override: (_label, messages) => (prompts.push(messages.map((m) => m.content).join('\n')), undefined) });
  return { prompts, queries, deps: { pool: p, chat, search, extract: fakeExtract(texts(urls)), youtube: fakeYoutube(), reachable: async () => true, now: () => NOW } };
}

db('a course with an industry researches in that industry\'s phrase, and the pipeline does not guess one', async (p) => {
  const c = await approved(p, 'fintech');
  const w = watched(p, c.urls);
  const r = await buildCourse(w.deps, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.prompts.filter((x) => GUESS.test(x)).length, 0, 'no guess was asked for');
  assert.ok(w.queries.length > 0 && w.queries.every((q) => q.includes('in fintech and payments software') || q.includes('fintech and payments software')), w.queries.join(' | '));
  assert.ok(w.prompts.some((x) => x.includes('The course is about fintech and payments software.')), 'the page judge and the fact extractor are told the industry');
});

db('a course with no industry keeps today\'s behaviour: the pipeline makes its own guess', async (p) => {
  const c = await approved(p, '');
  const w = watched(p, c.urls);
  const r = await buildCourse(w.deps, c.courseId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(w.prompts.filter((x) => GUESS.test(x)).length > 0, 'a guess was asked for');
});

db('what is researched is kept under the course\'s industry; a course with none keeps it under none', async (p) => {
  const a = await approved(p, 'fintech');
  assert.equal((await buildCourse(watched(p, a.urls).deps, a.courseId)).ok, true);
  const claims = (await p.query(`SELECT DISTINCT industry FROM concept_claims k JOIN role_concepts rc ON rc.id = k.concept_id WHERE rc.role_id = $1`, [a.roleId])).rows.map((x) => x.industry);
  const resources = (await p.query(`SELECT DISTINCT industry FROM resources r JOIN role_concepts rc ON rc.id = r.concept_id WHERE rc.role_id = $1`, [a.roleId])).rows.map((x) => x.industry);
  assert.deepEqual([claims, resources], [['fintech'], ['fintech']]);
});

db('a second industry for the same role is researched again, and the first industry\'s facts are neither reused nor overwritten', async (p) => {
  const a = await approved(p, 'fintech');
  assert.equal((await buildCourse(watched(p, a.urls).deps, a.courseId)).ok, true);
  const before = (await p.query(`SELECT id, claim, industry FROM concept_claims ORDER BY id`)).rows;
  const beforeRes = (await p.query(`SELECT id FROM resources ORDER BY id`)).rows;

  const b = await approved(p, 'healthcare', a);
  const w = watched(p, a.urls);
  assert.equal((await buildCourse(w.deps, b.courseId)).ok, true);
  assert.ok(w.queries.length > 0, 'the concepts were researched again, not taken from the fintech course');
  assert.ok(w.queries.every((q) => q.includes('healthcare')), w.queries.join(' | '));

  const after = (await p.query(`SELECT id, claim, industry FROM concept_claims ORDER BY id`)).rows;
  assert.deepEqual(after.filter((x) => x.industry === 'fintech'), before, 'the fintech facts are exactly as they were');
  assert.ok(after.some((x) => x.industry === 'healthcare'));
  assert.deepEqual((await p.query(`SELECT id FROM resources WHERE industry = 'fintech' ORDER BY id`)).rows, beforeRes);
});
