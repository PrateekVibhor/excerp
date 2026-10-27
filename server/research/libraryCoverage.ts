/**
 * Reference library dry run (plan 16, part 3, step B): how much of each saved course's concept list does the library mention? No Tavily credits, no
 * model calls, and nothing written to the database: the courses and their concepts are read from p4_run in a read-only session, the library's
 * readable sources are each fetched once and their text held in memory for this run, and the report is written to research/out/library-coverage.md.
 *   node --env-file=.env research/libraryCoverage.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { loadLibrary, sourcesFor, validateLibrary } from '../src/courses/library/load.ts';
import { coverageFor, type ConceptIn } from '../src/courses/library/match.ts';
import { renderReport, type CourseReport } from '../src/courses/library/report.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';

const here = new URL('.', import.meta.url).pathname;
const SCHEMA = 'p4_run';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy', options: `-c search_path=${SCHEMA} -c default_transaction_read_only=on` });
const slugOf = (role: string) => role.trim().toLowerCase().replace(/\s+/g, '-');

async function conceptsOf(courseId: string): Promise<ConceptIn[]> {
  const rows = (await pool.query(`SELECT k.name, k.kind, k.terms, k.mentions FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY cc.position`, [courseId])).rows;
  if (rows.length) return rows.map((r) => ({ name: r.name, kind: r.kind, terms: r.terms as string[], mentions: r.mentions }));
  try {
    // a build that stopped before the plan stage keeps its concept list in its snapshot
    const snap = JSON.parse(readFileSync(`${here}out/p4-snapshots/${courseId}.json`, 'utf8')) as { concepts: ConceptIn[] };
    return snap.concepts.map((c) => ({ name: c.name, kind: c.kind, terms: c.terms, mentions: c.mentions }));
  } catch {
    return [];
  }
}

try {
  const lib = loadLibrary(`${here}../reference-library`);
  const check = validateLibrary(lib);
  const courses = (await pool.query(`SELECT c.id, r.name, c.status FROM courses c JOIN roles r ON r.id = c.role_id ORDER BY c.created_at`)).rows as Array<{ id: string; name: string; status: string }>;

  // Each readable source of the roles that have a folder, fetched once (a source shared by two roles is one fetch); the text stays in this map.
  const wanted = new Map<string, { id: string; url: string; pipeline_readable: boolean }>();
  for (const c of courses) for (const s of sourcesFor(lib, slugOf(c.name))) wanted.set(s.id, s);
  const texts = new Map<string, string>();
  const failed = new Map<string, string>();
  const queue = [...wanted.values()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await fetchSourceText(s);
      if (r.ok) texts.set(s.id, r.text);
      else failed.set(s.id, r.reason);
      console.log(`${r.ok ? 'read   ' : 'skipped'} ${s.id}${r.ok ? ` (${r.kind}, ${Math.round(r.text.length / 1000)}k chars)` : `: ${r.reason}`}`);
    }
  }));

  const reports: CourseReport[] = [];
  for (const c of courses) {
    const slug = lib.roles[slugOf(c.name)] ? slugOf(c.name) : null;
    const concepts = await conceptsOf(c.id);
    const mine = slug ? sourcesFor(lib, slug) : [];
    reports.push({
      role: c.name, courseId: c.id, status: c.status, slug, concepts,
      sourcesRead: mine.filter((s) => texts.has(s.id)).length,
      sourcesSkipped: mine.filter((s) => failed.has(s.id)).map((s) => ({ id: s.id, reason: failed.get(s.id)! })),
      coverage: slug ? coverageFor(concepts, mine.filter((s) => texts.has(s.id)).map((s) => ({ id: s.id, text: texts.get(s.id)! }))) : null,
    });
  }
  const md = renderReport({ date: new Date().toISOString().slice(0, 10), library: { errors: check.errors.length, warnings: check.warnings.length }, courses: reports });
  mkdirSync(`${here}out`, { recursive: true });
  writeFileSync(`${here}out/library-coverage.md`, md);
  console.log(`\n${md}`);
} finally {
  await pool.end();
}
