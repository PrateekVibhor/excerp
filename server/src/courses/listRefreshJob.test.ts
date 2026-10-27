// The scheduled list-course refresh. It runs inside the existing worker process, on its own timer, and is off unless LIST_REFRESH_MINUTES is set. Each run is
// cheap when nothing changed, never overlaps another run (in this process or another), and does nothing, quietly, on a database that has no Plan 16 tables.
import assert from 'node:assert/strict';
import pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, publishedListCourse } from '../../testkit/courseFixtures.ts';
import type { Chat } from '../llm.ts';
import { loadConfig } from '../config.ts';
import type { LogEvent } from '../pipeline.ts';
import { enrolReader } from './enrol.ts';
import { libraryVersion, saveSource } from './library/db.ts';
import type { LibrarySource } from './library/load.ts';
import { runListRefresh, startListRefresh } from './listRefreshJob.ts';

const TABLES = ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files'];
const { db } = useCourseDb('refreshjob', { reset: TABLES });
const NOW = new Date('2026-10-25T12:00:00Z');
const SLUG = 'business-analyst';
const filler = 'Unrelated words about something else entirely, said at some length. '.repeat(5);
const PAGE = `${filler}Skill 3 explained. Learn skill 3. Practise skill 3. More on skill 3. ${filler}`;
const ent = (id: string) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active' }) as LibrarySource;
const chat: Chat = async (m) => {
  const system = m[0]!.content;
  const user = m.at(-1)!.content;
  if (/TEACHES a skill or only mentions it/.test(system)) {
    const ask = JSON.parse(user) as { categories: Array<{ id: string; excerpts: string[] }> };
    return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: 'teaches', evidence: (c.excerpts[0] ?? '').slice(10, 80) })) });
  }
  return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
};
const read = async (s: { id: string; url: string }) => (s.url.includes('new-a') ? ({ ok: true as const, id: s.id, text: PAGE, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
type P = Parameters<typeof publishedListCourse>[0];
async function world(p: P) {
  const c = await publishedListCourse(p, { concepts: 4, roleName: 'business analyst' });
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('lib-one'), SLUG, 'seed');
  await enrolReader(p, await account(p), c.courseId, 'business analyst', NOW);
  await p.query(`UPDATE list_concepts SET library_version = $2 WHERE course_id = $1`, [c.courseId, await libraryVersion(p)]);
  return c;
}
const deps = (p: P, log: LogEvent[] = []) => ({ pool: p, chat, read, now: () => NOW, log: (e: LogEvent) => log.push(e) });
const changes = async (p: P, courseId: string) => (await p.query(`SELECT target FROM course_changes WHERE course_id = $1`, [courseId])).rows.map((r) => r.target);

db('a run refreshes the list courses once the library has changed, logs what it did, and a second run finds nothing to do', async (p) => {
  const c = await world(p);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const log: LogEvent[] = [];
  const first = await runListRefresh(deps(p, log));
  assert.deepEqual(first, { status: 'ran', courses: 1, notified: 1, errors: 0 });
  assert.deepEqual(await changes(p, c.courseId), [c.conceptIds[2]]);
  assert.deepEqual(log.find((e) => e.event === 'list_refresh'), { event: 'list_refresh', courses: 1, notified: 1, errors: 0 });
  const second = await runListRefresh(deps(p, log));
  assert.deepEqual(second, { status: 'ran', courses: 1, notified: 0, errors: 0 });
  assert.equal((await changes(p, c.courseId)).length, 1);
});

db('with nothing changed a run costs no model calls and no page reads', async (p) => {
  await world(p);
  let model = 0;
  let pages = 0;
  const r = await runListRefresh({ ...deps(p), chat: async (m) => (model++, chat(m)), read: async (s) => (pages++, read(s)) });
  assert.deepEqual([r.status, model, pages], ['ran', 0, 0]);
});

db('a database without the Plan 16 tables is left alone: the run says so and does not fail', async (p) => {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const schema = `empty_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const bare = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const log: LogEvent[] = [];
    const r = await runListRefresh(deps(bare, log));
    assert.deepEqual(r, { status: 'skipped', reason: 'plan_16_tables_missing' });
    assert.ok(log.some((e) => e.event === 'list_refresh_skipped' && e.reason === 'plan_16_tables_missing'));
  } finally {
    await bare.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  void p;
});

db('a second run started while one is in progress (in this process or another) does nothing', async (p) => {
  const c = await world(p);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const other = new pg.Pool({ connectionString: url, max: 1 });
  const held = await other.connect();
  try {
    await held.query(`SELECT pg_advisory_lock(hashtext('excerp:list_refresh'))`); // another worker is mid-run
    const r = await runListRefresh(deps(p));
    assert.deepEqual(r, { status: 'skipped', reason: 'another_run_in_progress' });
    assert.deepEqual(await changes(p, c.courseId), [], 'nothing was refreshed');
  } finally {
    await held.query(`SELECT pg_advisory_unlock(hashtext('excerp:list_refresh'))`);
    held.release();
    await other.end();
  }
  assert.equal((await runListRefresh(deps(p))).status, 'ran', 'and once that run is over, this one can');
  assert.equal((await changes(p, c.courseId)).length, 1);
});

{
  const base = loadConfig({ TAVILY_API_KEY: 't', NEBIUS_API_KEY: 'n', NEBIUS_MODEL: 'm', DATABASE_URL: 'postgres://x' });
  db('the schedule is not started unless configured, and when it is, it runs at once and then every LIST_REFRESH_MINUTES, on a timer of its own', async (p) => {
    const off = startListRefresh({ config: { ...base, listRefreshMinutes: undefined }, ...deps(p) });
    assert.equal(off, undefined);
    const timers: number[] = [];
    let ran = 0;
    const on = startListRefresh({
      config: { ...base, listRefreshMinutes: 45 }, ...deps(p), runner: async () => { ran++; return { status: 'ran', courses: 0, notified: 0, errors: 0 }; },
      setTimer: (_fn, ms) => (timers.push(ms), 0), clearTimer: () => {},
    });
    assert.ok(on);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ran, 1, 'it ran once straight away');
    assert.ok(timers.length === 1 && timers[0]! <= 45 * 60_000 && timers[0]! > 45 * 60_000 - 5000, `and the next run is due in about 45 minutes: ${timers}`);
    await on!.stop();
  });

  db('a run that throws is logged and the schedule carries on', async (p) => {
    const log: LogEvent[] = [];
    const timers: number[] = [];
    const w = startListRefresh({ config: { ...base, listRefreshMinutes: 10 }, ...deps(p, log), runner: async () => { throw new Error('model unreachable'); }, setTimer: (_f, ms) => (timers.push(ms), 0), clearTimer: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    await w!.stop();
    assert.ok(log.some((e) => e.event === 'run_failed' && e.reason === 'model unreachable' && e.name === 'list_refresh'));
    assert.ok(timers.length === 1 && timers[0]! <= 10 * 60_000 && timers[0]! > 10 * 60_000 - 5000);
  });
}
