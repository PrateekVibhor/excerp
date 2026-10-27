/**
 * Phase 4 real run (plan 16): one role end to end, then a similar role to prove reuse. It runs the tested pipeline against a throwaway schema in
 * the local database (p4_run, never the app's own tables), through the P4 credit ledger (cap 700; the script stops at it and prints what it spent).
 *   node --env-file=.env research/p4Run.ts setup                       create the schema, the tracked companies and a research account (no credits)
 *   node --env-file=.env research/p4Run.ts find "backend software engineer" [--industry fintech]   find sources and stop at approval (searches only);
 *                                                                       the industry is optional, one of the API's keys (src/courses/industries.ts), and is the research hint for the build
 *   node --env-file=.env research/p4Run.ts approve <courseId>          the owner's approval, as the app records it (no credits)
 *   node --env-file=.env research/p4Run.ts build <courseId>            generate and publish the course
 *   node --env-file=.env research/p4Run.ts retry <courseId>            queue a failed build again (research already stored is not paid for twice)
 *   node --env-file=.env research/p4Run.ts status [courseId]           the ledger and the courses
 * P4_NO_RESEARCH=1 queues a build that must not pay for research; P4_LIBRARY=1 turns on library-first research for a build (a concept the role's reference
 * library covers is grounded from it and not searched for; the rest is researched live). Both are off unless set to exactly 1.
 * Keys are read from the environment and never printed.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { buildCourse } from '../src/courses/pipeline/build.ts';
import { createTavily, createYoutube } from '../src/courses/pipeline/clients.ts';
import { findCourseSources } from '../src/courses/pipeline/findSources.ts';
import { requeueBuild } from '../src/courses/pipeline/requeue.ts';
import type { Hit, SearchClient, SearchParams } from '../src/courses/pipeline/postings.ts';
import { CapReached, openLedger } from './creditLedger.ts';
import { courseInsert, describeIndustry, libraryOption, parseFindArgs } from './p4Industry.ts';

const SCHEMA = 'p4_run';
const here = new URL('.', import.meta.url).pathname;
const [command, arg] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy', options: `-c search_path=${SCHEMA}` });
const ledger = openLedger(`${here}out/ledger.json`, { phase: 'P4', cap: 700 });

const tokens = { in: 0, out: 0 };
const chat = () => createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 32_000, timeoutMs: 240_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });

/** Tavily through the ledger: every call is charged before it is made, and passing the cap stops the run. */
function ledgered(): SearchClient & { extract: (urls: string[]) => Promise<Record<string, string>> } {
  const tavily = createTavily(process.env.TAVILY_API_KEY!.trim());
  return {
    search: async (p: SearchParams): Promise<Hit[]> => (ledger.charge(1, `search: ${p.query.slice(0, 60)}`), console.log(`query: ${p.query}`), tavily.search(p)),
    extract: async (urls) => (ledger.charge(1, `extract ${urls.length} pages`), tavily.extract(urls)),
  };
}
const reachable = async (url: string) => {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return r.status < 400 || r.status === 405;
  } catch {
    return false;
  }
};

async function setup() {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy' });
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await admin.end();
  if (!(await pool.query(`SELECT to_regclass('${SCHEMA}.courses') AS t`)).rows[0].t) await pool.query(readFileSync(`${here}../schema.sql`, 'utf8'));
  else for (const m of ['011_course_industry', '012_library_use']) await pool.query(readFileSync(`${here}../migrations/${m}.sql`, 'utf8')); // an older schema gets the industry columns and the library tables (idempotent; existing rows are unchanged)
  const seed = JSON.parse(readFileSync(`${here}seedCompanies.json`, 'utf8')) as Array<{ employer: string; domains: string[] }>;
  let added = 0;
  for (const s of seed) for (const d of s.domains) added += (await pool.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ($1, $2, 'seed') ON CONFLICT (domain) DO NOTHING`, [s.employer, d.toLowerCase()])).rowCount ?? 0;
  await pool.query(`INSERT INTO accounts (google_sub, ref, email) VALUES ('p4-research', 'EXC-P4R0-0000', 'research@example.com') ON CONFLICT DO NOTHING`);
  console.log(`schema ${SCHEMA} ready; tracked companies added: ${added}`);
}

async function find(args: string[]) {
  const parsed = parseFindArgs(args);
  if (!parsed.ok) throw new Error(parsed.error); // refused before the database is touched or any credit is spent
  const { role: roleName, industry } = parsed;
  if (industry && !(await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'courses' AND column_name = 'industry'`, [SCHEMA])).rowCount) throw new Error('this schema has no industry column yet: run `setup` first (it applies migration 011)');
  const requester = (await pool.query(`SELECT id FROM accounts WHERE google_sub = 'p4-research'`)).rows[0].id;
  const role = (await pool.query(`INSERT INTO roles (name, description) VALUES ($1, '') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [roleName.toLowerCase()])).rows[0].id;
  const insert = courseInsert(role, roleName, requester, industry);
  const courseId = (await pool.query(insert.text, insert.values)).rows[0].id;
  console.log(describeIndustry(industry));
  const r = await findCourseSources({ pool, chat: chat(), search: ledgered(), creditBudget: 40 }, courseId);
  console.log(JSON.stringify({ courseId, ok: r.ok, ...(r.ok ? {} : { stage: r.stage, reason: r.reason }) }));
  const rows = (await pool.query(`SELECT cs.use, s.company, s.role_title, s.match, s.url FROM course_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.course_id = $1 ORDER BY cs.use, s.company`, [courseId])).rows;
  for (const x of rows) console.log(`${x.use.padEnd(8)} ${x.company} | ${x.role_title} | ${x.match} | ${x.url}`);
}

async function approve(courseId: string) {
  const c = (await pool.query(`SELECT status FROM courses WHERE id = $1`, [courseId])).rows[0];
  if (c?.status !== 'awaiting_approval') throw new Error(`the course is ${c?.status ?? 'missing'}, not awaiting approval`);
  const pooled = Number((await pool.query(`SELECT count(*) FROM course_sources WHERE course_id = $1 AND use = 'pool'`, [courseId])).rows[0].count);
  if (pooled < 8) throw new Error(`only ${pooled} postings: at least 8 are needed`);
  await pool.query(`UPDATE courses SET status = 'building', approved_at = now() WHERE id = $1`, [courseId]);
  await pool.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND use IN ('pool', 'reader') AND state = 'proposed'`, [courseId]);
  await pool.query(`UPDATE sources SET status = 'current' WHERE status = 'proposed' AND id IN (SELECT source_id FROM course_sources WHERE course_id = $1)`, [courseId]);
  const v = (await pool.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM course_versions WHERE course_id = $1), 'building') RETURNING id`, [courseId])).rows[0].id;
  const run = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, now()) RETURNING id`, [courseId, v])).rows[0].id;
  await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [v, run]);
  console.log(`approved ${courseId}; version ${v}, run ${run} queued`);
}

async function build(courseId: string) {
  try {
    console.log(describeIndustry(String((await pool.query(`SELECT industry FROM courses WHERE id = $1`, [courseId])).rows[0]?.industry ?? '')));
  } catch {
    throw new Error('this schema has no industry column yet: run `setup` first (it applies migration 011)'); // the build reads it too
  }
  const tavily = ledgered();
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const youtube = key ? createYoutube(key) : { search: async () => [], videos: async () => [] };
  if (!key) console.log('YOUTUBE_API_KEY is not set: no videos will be found');
  const before = tokens.in + tokens.out;
  if (libraryOption(process.env, here)) console.log('library-first research is ON (P4_LIBRARY=1)');
  let last = { in: tokens.in, out: tokens.out };
  const perStage: string[] = [];
  const onStage = (r: { stage: string; credits: number; failed: boolean }) => {
    perStage.push(`${r.stage}${r.failed ? ' (FAILED)' : ''}: ${r.credits} credits, ${tokens.in - last.in} tokens in, ${tokens.out - last.out} out`);
    console.log(perStage.at(-1));
    last = { in: tokens.in, out: tokens.out };
  };
  const r = await buildCourse({ pool, chat: chat(), noResearch: process.env.P4_NO_RESEARCH === '1', library: libraryOption(process.env, here), snapshotDir: new URL('out/p4-snapshots', import.meta.url).pathname, search: tavily, extract: tavily, youtube, reachable, creditBudget: 160, onStage, onClaims: (x) => console.log(`claims: ${x.round} "${x.chapter}": ${x.claims} claims, ${x.flagged} flagged${x.flaggedClaims.map((f) => `\n    - ${f}`).join('')}${x.blocking.map((b) => `\n    BLOCKING: ${b}`).join('')}${x.exempted.map((e) => `\n    EXEMPT (concept name): ${e}`).join('')}${x.driftCleared.map((d) => `\n    DRIFT CLEARED: ${d}`).join('')}${x.review.map((r) => `\n    >>> REVIEW (definition conflict, not blocked): ${r}`).join('')}`) }, courseId);
  await pool.query(`UPDATE course_runs SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3 WHERE id = (SELECT run_id FROM course_versions WHERE course_id = $1 ORDER BY version DESC LIMIT 1)`, [courseId, tokens.in, tokens.out]);
  console.log(JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { stage: r.stage, reason: r.reason }), notes: r.notes, tokens: tokens.in + tokens.out - before }));
}

async function status(courseId?: string) {
  console.log(ledger.summary());
  const rows = (await pool.query(`SELECT c.id, r.name, c.status, c.failure_reason, c.pool_size, (SELECT count(*) FROM course_chapters ch JOIN course_sections s ON s.id = ch.section_id WHERE s.course_id = c.id) AS chapters FROM courses c JOIN roles r ON r.id = c.role_id ${courseId ? 'WHERE c.id = $1' : ''} ORDER BY c.created_at`, courseId ? [courseId] : [])).rows;
  for (const x of rows) console.log(`${x.id} ${x.name} | ${x.status}${x.failure_reason ? ` (${x.failure_reason})` : ''} | pool ${x.pool_size} | chapters ${x.chapters}`);
  for (const run of (await pool.query(`SELECT course_id, kind, stage, percent, tavily_credits, tokens_in, tokens_out, error FROM course_runs ${courseId ? 'WHERE course_id = $1' : ''} ORDER BY id`, courseId ? [courseId] : [])).rows)
    console.log(`run ${run.kind} ${run.stage} ${run.percent}% credits ${run.tavily_credits} tokens ${Number(run.tokens_in) + Number(run.tokens_out)}${run.error ? ` ERROR ${run.error}` : ''}`);
}

try {
  if (command === 'setup') await setup();
  else if (command === 'find' && arg) await find(process.argv.slice(3));
  else if (command === 'approve' && arg) await approve(arg);
  else if (command === 'build' && arg) await build(arg);
  else if (command === 'retry' && arg) console.log(JSON.stringify(await requeueBuild(pool, arg)));
  else if (command === 'status') await status(arg);
  else console.log('usage: p4Run.ts setup | find "<role>" [--industry <key>] | approve <courseId> | build <courseId> | status [courseId]');
} catch (error) {
  if (error instanceof CapReached) console.log(`STOPPED: ${error.message}`);
  else console.log(`FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  console.log(ledger.summary());
  await pool.end();
}
