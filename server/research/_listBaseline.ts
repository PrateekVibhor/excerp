/** Read-only baseline for list mode (not committed): per role, how many of the course's concepts have strong / thin / missing resources. Network reads only; no credits, no model, no writes. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { loadLibrary, sourcesFor } from '../src/courses/library/load.ts';
import { coverageFor, termHits, type ConceptIn } from '../src/courses/library/match.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';

const here = new URL('.', import.meta.url).pathname;
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run -c default_transaction_read_only=on' });
const lib = loadLibrary(`${here}../reference-library`);
const slugOf = (r: string) => r.trim().toLowerCase().replace(/\s+/g, '-');
const ROLES = ['business analyst', 'product manager', 'forward-deployed engineer'];
const courses = (await pool.query(`SELECT c.id, r.name FROM courses c JOIN roles r ON r.id = c.role_id WHERE r.name = ANY($1) ORDER BY r.name`, [ROLES])).rows as Array<{ id: string; name: string }>;

const texts = new Map<string, string>(); const failed = new Map<string, string>();
const all = new Map<string, { id: string; url: string; pipeline_readable: boolean }>();
for (const c of courses) for (const s of sourcesFor(lib, slugOf(c.name))) all.set(s.id, s);
const queue = [...all.values()];
await Promise.all(Array.from({ length: 4 }, async () => { for (let s = queue.shift(); s; s = queue.shift()) { const r = await fetchSourceText(s); if (r.ok) texts.set(s.id, r.text); else failed.set(s.id, r.reason); } }));

const alive = new Map<string, boolean>();
const reachable = async (url: string) => {
  if (alive.has(url)) return alive.get(url)!;
  let ok = false;
  try { const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0' } }); ok = r.status < 400; } catch { /* dead */ }
  alive.set(url, ok); return ok;
};

type Band = 'strong' | 'thin' | 'missing';
const out: string[] = [`# List-mode baseline (${new Date().toISOString().slice(0, 10)})\n`, 'Read-only. A concept\'s links are the library sources whose text discusses it plus its stored live resources (checked reachable now). Strong = 2+ reachable links with 1+ library source; thin = one link, or only unvetted links; missing = none.\n'];
for (const minHits of [1, 3]) {
  out.push(`\n## Source "discusses" = at least ${minHits} mention${minHits > 1 ? 's' : ''}\n`);
  out.push('| Role | Concepts | Strong | Thin | Missing | Library-backed share | Any resource share |', '|---|---|---|---|---|---|---|');
  const detail: string[] = [];
  for (const c of courses) {
    const slug = slugOf(c.name);
    const concepts = (await pool.query(`SELECT k.id, k.name, k.kind, k.terms, k.mentions FROM course_concepts cc JOIN role_concepts k ON k.id = cc.concept_id WHERE cc.course_id = $1 ORDER BY cc.position`, [c.id])).rows as Array<ConceptIn & { id: string }>;
    const mine = sourcesFor(lib, slug).filter((s) => texts.has(s.id));
    const cov = coverageFor(concepts, mine.map((s) => ({ id: s.id, text: texts.get(s.id)! })));
    const bands: Record<Band, string[]> = { strong: [], thin: [], missing: [] };
    let libBacked = 0, anyRes = 0; const byKind: Record<string, { n: number; strong: number }> = {};
    for (const row of cov.rows) {
      const lsrc = row.sources.filter((s) => s.hits >= minHits || row.concept.kind === 'scenario').map((s) => s.id);
      const live = (await pool.query(`SELECT url FROM resources WHERE concept_id = $1 AND industry = ''`, [(row.concept as any).id])).rows.map((r) => r.url as string);
      const liveOk: string[] = []; for (const u of live) if (await reachable(u)) liveOk.push(u);
      const total = lsrc.length + liveOk.length;
      const band: Band = lsrc.length >= 1 && total >= 2 ? 'strong' : total === 0 ? 'missing' : 'thin';
      bands[band].push(`${row.concept.name} (${lsrc.length} library, ${liveOk.length} other)`);
      const bk = (byKind[row.concept.kind] ??= { n: 0, strong: 0 }); bk.n++; if (band === 'strong') bk.strong++;
      if (lsrc.length) libBacked++;
      if (total) anyRes++;
    }
    const n = concepts.length; const pct = (x: number) => `${Math.round((100 * x) / n)}%`;
    out.push(`| ${c.name} | ${n} | ${bands.strong.length} | ${bands.thin.length} | ${bands.missing.length} | ${libBacked} (${pct(libBacked)}) | ${anyRes} (${pct(anyRes)}) |`);
    out.push(`| &nbsp;&nbsp;by kind | ${Object.entries(byKind).map(([k, v]) => `${k}: ${v.strong}/${v.n} strong`).join(', ')} | | | | | |`);
    detail.push(`\n### ${c.name} (${minHits}+ mentions): ${mine.length} library sources read, ${[...all.values()].filter((s) => sourcesFor(lib, slug).some((x) => x.id === s.id) && !texts.has(s.id)).length} not readable\n\n**Missing (${bands.missing.length}):** ${bands.missing.join('; ') || 'none'}\n\n**Thin (${bands.thin.length}):** ${bands.thin.join('; ') || 'none'}\n`);
  }
  out.push(...detail);
}
out.push('\n## Library sources that were not readable\n', ...[...failed].map(([id, why]) => `- ${id}: ${why}`));
writeFileSync(`${here}out/list-mode-baseline.md`, out.join('\n'));
console.log(out.join('\n'));
await pool.end();
