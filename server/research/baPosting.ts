/**
 * A pasted job description, end to end in the p4_run sandbox: a private business analyst LIST course for the sandbox account, with a realistic description
 * pasted, the market postings of the existing BA course, research off (stored research only; search and extract refuse, so no Tavily credit can be spent), the
 * library from the database. Shows what the description added and how it is marked. Not committed.   node --env-file=.env research/baPosting.ts
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { buildCourse } from '../src/courses/pipeline/build.ts';
import { loadLibraryFromDb } from '../src/courses/library/db.ts';
import { createSources } from '../src/courses/sources.ts';
const here = new URL('.', import.meta.url).pathname;
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const refuse = (what: string) => () => { throw new Error(`${what} is not allowed in this run: it would spend a credit`); };
const reachable = async (url: string) => { try { const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0' } }); return r.status < 400 || r.status === 405 || r.status === 403; } catch { return false; } };
const JD = `Senior Business Analyst, Treasury Systems. You will partner with finance, operations and engineering to turn business needs into clear requirements for our treasury and cash-management platform.
Responsibilities: run requirements workshops and stakeholder interviews; write user stories with acceptance criteria and maintain a requirements traceability matrix; map current and future-state processes in BPMN; analyse payment and settlement data with SQL and build Power BI dashboards for operations leaders; coordinate user acceptance testing and triage defects with the QA team; support Oracle EBS financials upgrades and configuration changes; document controls for SOX and internal audit requests; use generative AI tools to draft first-pass requirements and summarise meeting notes, and check their output before sharing.
Qualifications: 5+ years as a business analyst in banking or fintech; strong stakeholder management and written communication; experience with agile delivery in Jira and Confluence; working knowledge of regulatory reporting and payment systems (ISO 20022); a degree in finance, information systems or similar.`;
try {
  await pool.query(readFileSync(`${here}../migrations/017_pasted_description.sql`, 'utf8'));
  await pool.query(readFileSync(`${here}../migrations/018_concept_tools.sql`, 'utf8'));
  await pool.query(readFileSync(`${here}../migrations/019_taxonomy_unplaced.sql`, 'utf8'));
  const narrow = (await pool.query(`SELECT id, role_id FROM courses WHERE role_id = (SELECT id FROM roles WHERE name = 'business analyst') AND mode = 'narrow'`)).rows[0];
  const owner = (await pool.query(`SELECT id FROM accounts ORDER BY created_at LIMIT 1`)).rows[0].id as string;
  await pool.query(`DELETE FROM courses WHERE role_id = $1 AND visibility = 'private' AND owner_account_id = $2`, [narrow.role_id, owner]);
  await pool.query(`DELETE FROM sources WHERE visibility = 'private' AND owner_account_id = $1`, [owner]);
  await pool.query(`DELETE FROM role_concepts WHERE visibility = 'private' AND owner_account_id = $1`, [owner]);
  const course = (await pool.query(`INSERT INTO courses (role_id, title, visibility, owner_account_id, requested_by, status, approved_at, mode, industry) VALUES ($1, 'business analyst', 'private', $2, $2, 'building', now(), 'list', 'banking') RETURNING id`, [narrow.role_id, owner])).rows[0].id as string;
  await pool.query(`INSERT INTO course_inputs (account_id, course_id, typed_text, pasted_text, last_active_at) VALUES ($1, $2, 'business analyst', $3, now())`, [owner, course, JD]);
  await pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) SELECT $1, source_id, use, 'approved' FROM course_sources WHERE course_id = $2 AND use = 'pool' AND state = 'approved'`, [course, narrow.id]);
  const sources = createSources(pool);
  const paste = await sources.registerPaste(narrow.role_id, owner, { roleTitle: 'business analyst' });
  await sources.attach(course, paste, 'reader');
  await pool.query(`UPDATE course_sources SET state = 'approved' WHERE course_id = $1 AND source_id = $2`, [course, paste]);
  const version = (await pool.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [course])).rows[0].id as string;
  const run = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, now()) RETURNING id`, [course, version])).rows[0].id as number;
  await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [version, run]);
  const r = await buildCourse({ pool, chat, search: { search: refuse('search') as never }, extract: { extract: refuse('extract') as never }, youtube: { search: async () => [], videos: async () => [] }, reachable, noResearch: true, library: { load: () => loadLibraryFromDb(pool) } }, course);
  console.log(JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { reason: (r as { reason?: string }).reason }) }), `model tokens ${tokens.in}/${tokens.out}`);
  for (const n of r.notes.filter((x) => x.startsWith('skill categories'))) console.log('NOTE:', n);
  const rows = (await pool.query(
    `SELECT l.position, l.display_name, k.name, k.terms, cc.tools, cc.skill_category, k.visibility, k.criticality, cc.from_reader_source AS only_yours, (cc.asked_by ? $2) AS in_posting, l.band, l.library_links, l.other_links
     FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id JOIN course_concepts cc ON cc.course_id = l.course_id AND cc.concept_id = l.concept_id WHERE l.version_id = $1 ORDER BY l.position`, [version, paste])).rows;
  const yours = rows.filter((x) => x.in_posting);
  console.log(`${rows.length} concepts; ${yours.length} come from the posting (${yours.filter((x) => x.only_yours).length} only from it, private; ${yours.filter((x) => !x.only_yours).length} the market asks for too)`);
  for (const x of rows) console.log(`${String(x.position + 1).padStart(2)}. ${x.in_posting ? '[YOUR POSTING]' : '              '} ${x.only_yours ? '(only yours, private)' : x.criticality ? `(market: ${x.criticality})` : ''} ${x.display_name} [${x.band}] (${x.library_links}L ${x.other_links}O)`);
  console.log('\nWhat the posting\'s concepts are now:');
  for (const x of yours.filter((y) => y.only_yours)) console.log(`- ${x.name}${x.tools.length ? `  [tools noted: ${x.tools.join(', ')}]` : ''}${x.terms.length > 1 ? `\n    gathers: ${x.terms.join(' | ')}` : ''}`);
  const shared = (await pool.query(`SELECT count(*)::int AS n FROM role_concepts WHERE role_id = $1 AND visibility = 'shared' AND mentions = 0`, [narrow.role_id])).rows[0].n;
  console.log(`shared role concepts with no market mentions: ${shared}; private concepts: ${(await pool.query(`SELECT count(*)::int AS n FROM role_concepts WHERE visibility = 'private'`)).rows[0].n}`);
} finally {
  await pool.end();
}
