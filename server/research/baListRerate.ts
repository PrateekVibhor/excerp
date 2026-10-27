/**
 * Re-rate the business analyst LIST course with the teaches-not-mentions check on library links (p4_run only; no Tavily, research off). The same 27 concepts are
 * kept (through a snapshot) so before and after compare like with like. Not committed.   node --env-file=.env research/baListRerate.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const table = async (courseId: string) => (await pool.query(`SELECT l.position, l.display_name, k.name, l.band, l.library_links, l.other_links FROM list_concepts l JOIN role_concepts k ON k.id = l.concept_id JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 ORDER BY l.position`, [courseId])).rows as Array<{ position: number; display_name: string; name: string; band: string; library_links: number; other_links: number }>;
try {
  const old = (await pool.query(`SELECT id, role_id FROM courses WHERE mode = 'list' AND role_id = (SELECT id FROM roles WHERE name = 'business analyst')`)).rows[0];
  const before = await table(old.id);
  const concepts = (await pool.query(`SELECT k.name, k.kind, k.terms, k.mentions, k.of_postings AS of, k.criticality, cc.from_reader_source AS "fromReaderSource" FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY cc.position`, [old.id])).rows;
  const dir = mkdtempSync(join(tmpdir(), 'ba-snap-'));
  const narrow = (await pool.query(`SELECT id FROM courses WHERE role_id = $1 AND mode = 'narrow'`, [old.role_id])).rows[0];
  // a fresh list course for the same role, with the same approved postings, and the same concepts in the same order (kept in a snapshot)
  await pool.query(`DELETE FROM courses WHERE id = $1`, [old.id]);
  const list = (await pool.query(`INSERT INTO courses (role_id, title, visibility, status, approved_at, mode) VALUES ($1, 'business analyst', 'shared', 'building', now(), 'list') RETURNING id`, [old.role_id])).rows[0];
  await pool.query(`INSERT INTO course_sources (course_id, source_id, use, state) SELECT $1, source_id, use, 'approved' FROM course_sources WHERE course_id = $2 AND use = 'pool' AND state = 'approved'`, [list.id, narrow.id]);
  const version = (await pool.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 1, 'building') RETURNING id`, [list.id])).rows[0];
  const run = (await pool.query(`INSERT INTO course_runs (course_id, version_id, kind, stage, percent, started_at) VALUES ($1, $2, 'generation', 'queued', 0, now()) RETURNING id`, [list.id, version.id])).rows[0];
  await pool.query(`UPDATE course_versions SET run_id = $2 WHERE id = $1`, [version.id, run.id]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${list.id}.json`), JSON.stringify({ concepts, order: concepts.map((c) => c.name), story: { bible: { setting: '', character: '', thread: '', voice: '' }, sections: [] }, bodies: [], coherent: false }));
  const r = await buildCourse({
    pool, chat, search: { search: refuse('search') as never }, extract: { extract: refuse('extract') as never }, youtube: { search: async () => [], videos: async () => [] },
    reachable, noResearch: true, library: { load: () => loadLibraryFromDb(pool) }, snapshotDir: dir,
  }, list.id);
  const after = await table(list.id);
  const rank = { strong: 2, thin: 1, missing: 0 } as Record<string, number>;
  const byName = new Map(after.map((a) => [a.name, a]));
  const move = (from: string, to: string) => before.filter((b) => b.band === from && byName.get(b.name)?.band === to).length;
  const count = (rows: typeof after, b: string) => rows.filter((x) => x.band === b).length;
  const out = [`# BA list course: loose match vs teaches-not-mentions check (p4_run)\n`, `build ok: ${r.ok}; model tokens ${tokens.in} in / ${tokens.out} out; no search credits\n`,
    `| | before | after |`, `|---|---|---|`,
    `| concepts | ${before.length} | ${after.length} |`, `| strong | ${count(before, 'strong')} | ${count(after, 'strong')} |`, `| thin | ${count(before, 'thin')} | ${count(after, 'thin')} |`, `| missing | ${count(before, 'missing')} | ${count(after, 'missing')} |`,
    `| library-backed | ${before.filter((x) => x.library_links > 0).length} | ${after.filter((x) => x.library_links > 0).length} |`, `| any link | ${before.filter((x) => x.library_links + x.other_links > 0).length} | ${after.filter((x) => x.library_links + x.other_links > 0).length} |`,
    `\nmoves: strong->thin ${move('strong', 'thin')}, strong->missing ${move('strong', 'missing')}, thin->missing ${move('thin', 'missing')}, thin->strong ${move('thin', 'strong')}, missing->thin ${move('missing', 'thin')}, unchanged ${before.filter((b) => b.band === byName.get(b.name)?.band).length}`,
    `\n| # | concept | before | after | library links before->after |`, `|---|---|---|---|---|`,
    ...before.map((b) => { const a = byName.get(b.name); return `| ${b.position + 1} | ${b.display_name} | ${b.band} (${b.library_links}L ${b.other_links}O) | ${a ? `${a.band} (${a.library_links}L ${a.other_links}O)` : 'gone'}${a && rank[a.band]! !== rank[b.band]! ? (rank[a.band]! < rank[b.band]! ? ' **down**' : ' **up**') : ''} | ${b.library_links}->${a?.library_links ?? 0} |`; })];
  const links = (await pool.query(`SELECT k.name, l.title FROM list_links l JOIN role_concepts k ON k.id = l.concept_id JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 AND l.library_source_id IS NOT NULL ORDER BY k.name`, [list.id])).rows;
  out.push('\nLibrary links that now count:', ...links.map((l) => `- ${l.name}: ${l.title}`));
  writeFileSync(`${here}out/ba-list-rerate.md`, out.join('\n'));
  console.log(out.join('\n'));
} finally {
  await pool.end();
}
