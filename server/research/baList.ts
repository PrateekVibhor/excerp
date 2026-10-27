/**
 * Business analyst LIST course, built for real in the p4_run sandbox (plan 16, part 7): the narrative BA course's approved postings are reused, research is
 * NOT run (stored research only; search and extract are wired to refuse, so no Tavily credit can be spent), the library is read from the database, and the
 * links go through the audience judge. Not committed.   node --env-file=.env research/baList.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { buildCourse } from '../src/courses/pipeline/build.ts';
import { loadLibraryFromDb } from '../src/courses/library/db.ts';
const here = new URL('.', import.meta.url).pathname;
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const refuse = (what: string) => () => { throw new Error(`${what} is not allowed in this run: it would spend a credit`); };
const reachable = async (url: string) => { try { const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0' } }); return r.status < 400 || r.status === 405 || r.status === 403; } catch { return false; } };
try {
  await pool.query(readFileSync(`${here}../migrations/015_list_mode.sql`, 'utf8'));
  const narrow = (await pool.query(`SELECT c.id, c.role_id FROM courses c JOIN roles r ON r.id = c.role_id WHERE r.name = 'business analyst' AND c.mode = 'narrow'`)).rows[0];
  let list = (await pool.query(`SELECT id FROM courses WHERE role_id = $1 AND mode = 'list'`, [narrow.role_id])).rows[0];
  if (!list) {
    list = (await pool.query(`INSERT INTO courses (role_id, title, visibility, status, approved_at, mode) VALUES ($1, 'business analyst', 'shared', 'building', now(), 'list') RETURNING id`, [narrow.role_id])).rows[0];
    await pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) SELECT $1, source_id, use, 'approved' FROM course_sources WHERE course_id = $2 AND use = 'pool' AND state = 'approved'`, [list.id, narrow.id]);
  }
  let version = (await pool.query(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'building'`, [list.id])).rows[0];
  if (!version) {
    version = (await pool.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM course_versions WHERE course_id = $1), 'building') RETURNING id`, [list.id])).rows[0];
    const run = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, now()) RETURNING id`, [list.id, version.id])).rows[0];
    await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [version.id, run.id]);
  }
  const stages: string[] = [];
  const r = await buildCourse({
    pool, chat, search: { search: refuse('search') as never }, extract: { extract: refuse('extract') as never }, youtube: { search: async () => [], videos: async () => [] },
    reachable, noResearch: true, library: { load: () => loadLibraryFromDb(pool) },
    onStage: (s) => void stages.push(`${s.stage}${s.failed ? ' (FAILED)' : ''}: ${s.credits} credits`),
  }, list.id);
  const out = [`# BA list course (p4_run) ${list.id}\n`, JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { stage: (r as { stage?: string }).stage, reason: (r as { reason?: string }).reason }), notes: r.notes.slice(0, 5) }), `stages: ${stages.join(' | ')}`, `model tokens ${tokens.in} in / ${tokens.out} out`];
  if (r.ok) {
    const rows = (await pool.query(`SELECT l.position, l.display_name, k.name, l.band, l.library_links, l.other_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 ORDER BY l.position`, [list.id])).rows;
    const count = (b: string) => rows.filter((x) => x.band === b).length;
    out.push(`\nmeter: ${rows.length} concepts: strong ${count('strong')}, thin ${count('thin')}, missing ${count('missing')}; library-backed ${rows.filter((x) => x.library_links > 0).length}; with any link ${rows.filter((x) => x.library_links + x.other_links > 0).length}\n`);
    for (const x of rows) out.push(`${String(x.position + 1).padStart(2)}. [${x.band.padEnd(7)}] ${x.display_name}  (${x.name})  library ${x.library_links}, other ${x.other_links}`);
    const links = (await pool.query(`SELECT k.name, l.kind, l.title, l.url, l.library_source_id FROM list_links l JOIN role_concepts k ON k.id = l.concept_id JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 ORDER BY l.concept_id, l.position LIMIT 400`, [list.id])).rows;
    out.push('\nlinks shown (first 25):', ...links.slice(0, 25).map((x) => `- ${x.name}: ${x.library_source_id ? '[library] ' : ''}${x.title.slice(0, 70)} <${x.url.slice(0, 90)}>`));
  }
  writeFileSync(`${here}out/ba-list-course.md`, out.join('\n'));
  console.log(out.join('\n'));
} finally {
  await pool.end();
}
