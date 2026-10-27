// A server to look at the app's Skills list tab on a simulator: the end-to-end server with the course routes on, and a reader (tester@example.com) who has six skills lists in
// different states (new coverage, building, shared, mostly missing, failed, old), spread over every group of the list panel. Controls change what happens: finish the build, empty the
// reader's lists, switch the credit cap on, make the library newer so "Refresh now" has something to check, and finish that check. Dev only: it lives outside src/, so the image never has it.
// Run it with `npm run demo:lists`. The sample links open a small page on this server, so nothing here ever points at a live address.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createAccountStore } from '../src/accounts.ts';
import { saveSource } from '../src/courses/library/db.ts';
import type { LibrarySource } from '../src/courses/library/load.ts';
import { createCourseSettings } from '../src/courses/settings.ts';
import { publishedListCourse } from '../testkit/courseFixtures.ts';
import { APPROVED_TEST_EMAIL, createE2eServer, type E2eServer } from './server.ts';

const SLUG = 'business-analyst';
type Link = { title: string; host: string; library: boolean };
const lib = (title: string, host: string): Link => ({ title, host, library: true });
const web = (title: string, host: string): Link => ({ title, host, library: false });

/** The concepts of a list in learning order: five strong, three thin and two missing, so every rating is on screen. */
const CONCEPTS: Array<{ name: string; explain: string; links: Link[] }> = [
  { name: 'Requirements elicitation', explain: 'Finding out what stakeholders need through interviews, workshops and observation.', links: [lib('A guide to the business analysis body of knowledge', 'iiba.org'), web('How to interview stakeholders', 'example.org')] },
  { name: 'Requirements analysis and documentation', explain: 'Turning what was heard into clear, testable requirements.', links: [lib('Writing good requirements', 'atlassian.com'), lib('Requirements traceability matrix', 'pmi.org'), web('Requirements templates', 'example.org')] },
  { name: 'User stories and acceptance criteria', explain: 'Writing small, testable descriptions of what a user needs.', links: [lib('User stories with examples', 'atlassian.com'), web('Acceptance criteria that work', 'example.org')] },
  { name: 'Process modeling and improvement', explain: 'Drawing how work flows today and where it could be better.', links: [lib('BPMN 2.0 quick guide', 'omg.org'), web('Process mapping basics', 'example.org')] },
  { name: 'SQL and data querying', explain: 'Asking a database questions to check what the data says.', links: [lib('SQL tutorial', 'mode.com'), web('SQL practice set', 'example.org')] },
  { name: 'Reporting, KPIs and dashboards', explain: 'Choosing the measures that matter and showing them clearly.', links: [lib('Dashboard design guided learning', 'learn.microsoft.com')] },
  { name: 'Testing and user acceptance', explain: 'Checking that what was built does what was asked.', links: [web('Planning user acceptance testing', 'example.org')] },
  { name: 'Compliance, controls and risk', explain: 'Knowing the controls a regulated business has to show.', links: [web('Internal control framework overview', 'example.org')] },
  { name: 'ISO 20022 payment standards', explain: 'The message standard banks use to describe payments.', links: [] },
  { name: 'Treasury and cash management', explain: 'How a company manages its cash, liquidity and bank accounts.', links: [] },
];
const STAGES = ['', 'read', 'rank', 'delta', 'reference', 'sequence', 'list', 'publish'];
const POSTING = 'Business analyst. Responsibilities: gather requirements, run workshops, write user stories. Skills: SQL, Tableau, stakeholder management.';

export interface DemoIds { main: string; building: string; shared: string; healthcare: string; failed: string; old: string }

/** Where a sample link goes: a placeholder page on this server (never a live address). */
const pageUrl = (base: string, title: string) => `${base}/e2e/demo/page?t=${encodeURIComponent(title)}`;
/** A local day-time, `daysAgo` days back, so the list panel's groups (which go by the reader's calendar days) come out the same every time. */
const dayAt = (daysAgo: number, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let newSource = 0;
const entry = (id: string): LibrarySource => ({ id, name: `New source ${id}`, url: `http://localhost/e2e/demo/page?t=${id}`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active' }) as LibrarySource;

/** Empties the course tables and puts the demo lists back. Returns each list's course id. */
export async function seedListDemo(pool: pg.Pool, base = 'http://localhost:8787'): Promise<DemoIds> {
  for (const t of ['roles', 'library_sources', 'library_changes', 'library_role_files', 'course_settings']) await pool.query(`TRUNCATE ${t} CASCADE`);
  await createCourseSettings(pool).set('courses_off', false);
  const { id: reader } = await createAccountStore(pool).upsert({ sub: `e2e-sub-${APPROVED_TEST_EMAIL}`, email: APPROVED_TEST_EMAIL });
  await pool.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);

  // The shared list everything else is copied from: ten concepts with links, some of them from the library.
  const shared = await publishedListCourse(pool, { concepts: CONCEPTS.length, roleName: 'business analyst' });
  await pool.query(`UPDATE courses SET industry = 'fintech', title = 'business analyst' WHERE id = $1`, [shared.courseId]);
  await pool.query(`DELETE FROM list_links WHERE course_id = $1`, [shared.courseId]);
  await pool.query(`DELETE FROM list_concepts WHERE course_id = $1`, [shared.courseId]);
  let libraryId = 0;
  for (const [i, k] of CONCEPTS.entries()) {
    const conceptId = shared.conceptIds[i]!;
    await pool.query(`UPDATE role_concepts SET name = $2, plain_explanation = $3 WHERE id = $1`, [conceptId, k.name.toLowerCase(), k.explain]);
    for (const [j, l] of k.links.entries()) {
      const url = pageUrl(base, l.title);
      let libId: string | null = null;
      if (l.library) {
        libId = `demo-${++libraryId}`;
        await pool.query(`INSERT INTO library_sources (id, scope, name, url, tier, layer, access, perspective, pipeline_readable, applies_to, status, entry) VALUES ($1,$2,$3,$4,1,'institutional','open','canonical',true,$5,'active','{}')`, [libId, SLUG, l.title, url, [SLUG]]);
      }
      await pool.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) VALUES ($1,$2,$3,$4,'article',$5,$6,$7,'explains it plainly',$8)`, [shared.courseId, shared.versionId, conceptId, j, l.title, l.host, url, libId]);
    }
    const library = k.links.filter((l) => l.library).length;
    const band = library >= 1 && k.links.length >= 2 ? 'strong' : k.links.length ? 'thin' : 'missing';
    await pool.query(`INSERT INTO list_concepts (course_id, version_id, concept_id, position, display_name, band, library_links, other_links) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [shared.courseId, shared.versionId, conceptId, i, k.name, band, library, k.links.length - library]);
  }

  /** The reader's entry for a course: when they started and last used it, their own name for it, and what they have seen. */
  const enrol = (courseId: string, o: { used: Date; title?: string; seen: number; pasted?: boolean }) =>
    pool.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at, created_at, title) VALUES ($1, $2, 'business analyst', $3, $4, $4, $5)`, [reader, courseId, o.pasted ? POSTING : null, o.used, o.title ?? null])
      .then(() => pool.query(`INSERT INTO course_seen (account_id, course_id, seen_version) VALUES ($1, $2, $3)`, [reader, courseId, o.seen]));
  /** A copy of the shared list's content, as the reader's own private list: its concepts, links and ratings under a version of its own. */
  const copyContent = async (courseId: string, versionId: string, keep?: number) => {
    await pool.query(`INSERT INTO course_concepts (course_id, concept_id, position) SELECT $1, concept_id, position FROM course_concepts WHERE course_id = $2`, [courseId, shared.courseId]);
    await pool.query(`INSERT INTO list_concepts (course_id, version_id, concept_id, position, display_name, band, library_links, other_links) SELECT $1, $2, concept_id, position, display_name, band, library_links, other_links FROM list_concepts WHERE version_id = $3`, [courseId, versionId, shared.versionId]);
    await pool.query(`INSERT INTO list_links (course_id, version_id, concept_id, position, kind, title, source, url, why, library_source_id) SELECT $1, $2, concept_id, position, kind, title, source, url, why, library_source_id FROM list_links WHERE version_id = $3`, [courseId, versionId, shared.versionId]);
    if (keep !== undefined) {
      // a list with little covered: only the first `keep` concepts keep their links
      await pool.query(`DELETE FROM list_links WHERE version_id = $1 AND concept_id IN (SELECT concept_id FROM list_concepts WHERE version_id = $1 AND position >= $2)`, [versionId, keep]);
      await pool.query(`UPDATE list_concepts SET band = 'missing', library_links = 0, other_links = 0 WHERE version_id = $1 AND position >= $2`, [versionId, keep]);
    }
  };
  const privateCourse = async (o: { industry: string | null; status: string; reason?: string; at: Date }) =>
    (await pool.query(
      `INSERT INTO courses (role_id, title, visibility, owner_account_id, requested_by, status, failure_reason, approved_at, generated_at, pool_size, industry, mode, independent, model, created_at)
       VALUES ($1, 'business analyst', 'private', $2, $2, 'building', $3, $4, $4, 9, $5, 'list', true, 'demo-model', $4) RETURNING id`,
      [shared.roleId, reader, o.reason ?? null, o.at, o.industry ?? ''],
    )).rows[0].id as string;
  /** A ready private list: published as version `version`, its generation run recording some credits. */
  async function readyList(o: { industry: string | null; used: Date; title?: string; seen: number; version: number; keep?: number; credits: number; checkedMinutesAgo: number }) {
    const courseId = await privateCourse({ industry: o.industry, status: 'ready', at: o.used });
    const versionId = (await pool.query(`INSERT INTO course_versions (course_id, version, status, published_at) VALUES ($1, $2, 'published', $3) RETURNING id`, [courseId, o.version, o.used])).rows[0].id as string;
    await pool.query(`UPDATE courses SET status = 'ready', published_version = $2, last_checked_at = $3 WHERE id = $1`, [courseId, versionId, new Date(Date.now() - o.checkedMinutesAgo * 60_000)]);
    const runId = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, tavily_credits, tokens_in, tokens_out, started_at, finished_at) VALUES ($1, $2, 'generation', $3, 'publish', 100, $4, 90000, 20000, $5, $5) RETURNING id`, [courseId, versionId, reader, o.credits, o.used])).rows[0].id as number;
    await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [versionId, runId]);
    await copyContent(courseId, versionId, o.keep);
    await enrol(courseId, { used: o.used, title: o.title, seen: o.seen, pasted: true });
    return { courseId, versionId };
  }

  // 1. new coverage the reader has not seen: published as the second version, seen up to the first
  const main = await readyList({ industry: 'fintech', used: new Date(Date.now() - 5 * 60_000), title: 'Treasury systems role', seen: 1, version: 2, credits: 24, checkedMinutesAgo: 40 });
  await addRise(pool, main.courseId);
  // 2. the shared list: up to date, as every reader of the role and industry has it
  await pool.query(`UPDATE courses SET requested_by = NULL, last_checked_at = $2 WHERE id = $1`, [shared.courseId, new Date(Date.now() - 180 * 60_000)]);
  await enrol(shared.courseId, { used: dayAt(1), seen: 1 });
  // 3. a list with little covered
  const healthcare = await readyList({ industry: 'healthcare', used: dayAt(3), title: 'Hospital data analyst', seen: 1, version: 1, keep: 3, credits: 19, checkedMinutesAgo: 25 * 60 });
  // 6. an old one
  const old = await readyList({ industry: null, used: dayAt(20), seen: 1, version: 1, credits: 27, checkedMinutesAgo: 20 * 24 * 60 });
  // 4. a list being built, at the reference stage
  const buildingAt = new Date(Date.now() - 40 * 60_000);
  const building = await privateCourse({ industry: 'fintech', status: 'building', at: buildingAt });
  const buildingVersion = (await pool.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [building])).rows[0].id as string;
  const buildingRun = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, requested_by, stage, percent, tavily_credits, started_at) VALUES ($1, $2, 'generation', $3, 'reference', 62, 12, $4) RETURNING id`, [building, buildingVersion, reader, buildingAt])).rows[0].id as number;
  await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [buildingVersion, buildingRun]);
  await copyContent(building, buildingVersion);
  await enrol(building, { used: buildingAt, seen: 0, pasted: true });
  // 5. a list that could not be built
  const failedAt = dayAt(5);
  const failed = await privateCourse({ industry: 'banking', status: 'failed', reason: 'not_enough_postings', at: failedAt });
  await pool.query(`UPDATE courses SET status = 'failed', approved_at = NULL, generated_at = NULL WHERE id = $1`, [failed]);
  await enrol(failed, { used: failedAt, seen: 0, pasted: true });

  return { main: main.courseId, building, shared: shared.courseId, healthcare: healthcare.courseId, failed, old: old.courseId };
}

/** A rating that went up on a ready list: its published version moves on, with one coverage change the reader has not seen. */
async function addRise(pool: pg.Pool, courseId: string) {
  const v = (await pool.query(`SELECT published_version AS id FROM courses WHERE id = $1`, [courseId])).rows[0].id as string;
  await pool.query(`UPDATE course_versions SET version = version + 1 WHERE id = $1`, [v]);
  // a concept this list has not announced yet (a missing one first), so a list can be given one rise after another
  const k = (await pool.query(
    `SELECT concept_id, display_name FROM list_concepts WHERE version_id = $1 AND concept_id::text NOT IN (SELECT target FROM course_changes WHERE version_id = $1 AND kind = 'coverage_improved' AND target IS NOT NULL) ORDER BY (band = 'missing') DESC, position LIMIT 1`,
    [v],
  )).rows[0];
  if (!k) return;
  await pool.query(`INSERT INTO course_changes (course_id, version_id, kind, target, summary, published_at) VALUES ($1, $2, 'coverage_improved', $3, $4, now() - interval '3 days')`, [courseId, v, k.concept_id, `${k.display_name}: now thin, with 1 vetted source (was missing)`]);
}

/** The end-to-end server with the course routes on, the demo lists seeded, and controls to change what the reader sees. */
export async function createListDemoServer(options: { databaseUrl: string; port?: number; host?: string }): Promise<E2eServer> {
  const server = await createE2eServer({ ...options, courses: true });
  const base = `http://localhost:${options.port ?? 8787}`;
  let ids = await seedListDemo(server.pool, base);
  const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: message });

  server.app.post('/e2e/demo/reset', async () => {
    ids = await seedListDemo(server.pool, base);
    return { status: 'reset', lists: ids };
  });
  server.app.post('/e2e/demo/building', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { stage?: unknown; percent?: unknown };
    if (typeof body.stage !== 'string' || !STAGES.includes(body.stage) || typeof body.percent !== 'number' || !(body.percent >= 0 && body.percent <= 100)) return bad(reply, `stage is one of ${STAGES.map((s) => `"${s}"`).join(', ')}; percent is 0 to 100`);
    await server.pool.query(`UPDATE course_runs SET stage = $2, percent = $3 WHERE course_id = $1 AND kind = 'generation' AND finished_at IS NULL`, [ids.building, body.stage, body.percent]);
    return { status: 'building', stage: body.stage, percent: body.percent };
  });
  server.app.post('/e2e/demo/finish-building', async () => {
    const v = (await server.pool.query(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'building'`, [ids.building])).rows[0]?.id as string | undefined;
    if (v) {
      await server.pool.query(`UPDATE course_versions SET status = 'published', published_at = now() WHERE id = $1`, [v]);
      await server.pool.query(`UPDATE courses SET status = 'ready', published_version = $2, generated_at = now() WHERE id = $1`, [ids.building, v]);
      await server.pool.query(`UPDATE course_runs SET stage = 'publish', percent = 100, finished_at = now() WHERE course_id = $1 AND kind = 'generation' AND finished_at IS NULL`, [ids.building]);
    }
    return { status: 'ready' };
  });
  server.app.post('/e2e/demo/none', async () => {
    await server.pool.query(`DELETE FROM course_inputs WHERE account_id = (SELECT id FROM accounts WHERE email = $1)`, [APPROVED_TEST_EMAIL]);
    return { status: 'none' };
  });
  server.app.post('/e2e/demo/cap', async (request: FastifyRequest, reply: FastifyReply) => {
    const on = ((request.body ?? {}) as { on?: unknown }).on;
    if (typeof on !== 'boolean') return bad(reply, 'on is true or false');
    await createCourseSettings(server.pool).set('cap.credits_total', on ? 1 : 0); // the lists record credits already, so 1 is reached at once
    return { status: 'cap', on };
  });
  server.app.post('/e2e/demo/library-update', async () => {
    await saveSource(server.pool, entry(`demo-new-${++newSource}`), SLUG, 'finder');
    return { status: 'library updated' };
  });
  server.app.post('/e2e/demo/checking-done', async (request: FastifyRequest) => {
    const rise = ((request.body ?? {}) as { rise?: unknown }).rise === true;
    const running = (await server.pool.query(`UPDATE course_runs SET finished_at = now(), stage = 'done', percent = 100 WHERE kind = 'refresh' AND finished_at IS NULL RETURNING course_id`)).rows as Array<{ course_id: string }>;
    for (const { course_id } of running) {
      await server.pool.query(`UPDATE courses SET last_checked_at = now() WHERE id = $1`, [course_id]);
      if (rise) await addRise(server.pool, course_id);
    }
    return { status: 'checked', lists: running.length, rise };
  });
  server.app.get('/e2e/demo/page', async (request: FastifyRequest, reply: FastifyReply) => {
    const title = String(((request.query ?? {}) as { t?: unknown }).t ?? 'Sample resource').slice(0, 200);
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><body style="font:17px system-ui;margin:32px;line-height:1.5"><p style="color:#4f6b66;font:12px ui-monospace,monospace">DEMO RESOURCE</p><h1>${html(title)}</h1><p>This is a placeholder page on the demo server. In the real app a link like this opens the page it names.</p></body>`);
  });
  return server;
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const port = Number(process.env.E2E_PORT ?? 8787);
  const server = await createListDemoServer({ databaseUrl, port });
  const { host, port: bound } = await server.listen();
  console.log(`List-course demo server ready on http://${host}:${bound} (schema ${server.schema})`);
  console.log('Sign in as "Test reader: approved". Controls (POST): /e2e/demo/reset, building, finish-building, none, cap, library-update, checking-done');
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
