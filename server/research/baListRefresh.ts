/**
 * The notification loop for the business analyst LIST course, in the p4_run sandbox. No Tavily; the library pages are fetched and the model judges them.
 *   node --env-file=.env research/baListRefresh.ts setup     apply migration 016 and enrol a sandbox reader in the list course
 *   node --env-file=.env research/baListRefresh.ts status    stored ratings, versions, announced changes and what the reader sees
 *   node --env-file=.env research/baListRefresh.ts refresh   the scheduled run (run it from cron or CI): refresh every ready BA list course
 *   node --env-file=.env research/baListRefresh.ts admit     admit the finder's proposed pages (two runs + coverage gate), rate, and refresh the list courses
 *   node --env-file=.env research/baListRefresh.ts audit     audit the admitted pages, rate, and refresh the list courses
 * Not committed.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createNebiusChat } from '../src/llm.ts';
import { admitAndRate, auditAndRate } from '../src/courses/gaps/admit.ts';
import { enrolReader } from '../src/courses/enrol.ts';
import { fetchSourceText } from '../src/courses/library/text.ts';
import { libraryVersion, setSourceStatus } from '../src/courses/library/db.ts';
import { refreshListCourses } from '../src/courses/listRefresh.ts';
import { createCourseReads } from '../src/courses/reads.ts';
const here = new URL('.', import.meta.url).pathname;
const SLUG = 'business-analyst';
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: '-c search_path=p4_run' });
const tokens = { in: 0, out: 0 };
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 8000, timeoutMs: 180_000, onUsage: (u) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens)) });
const deps = { pool, chat, read: fetchSourceText };
const course = async () => (await pool.query(`SELECT c.id, c.published_version FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.mode = 'list' AND r.name = 'business analyst'`)).rows[0];
try {
  const [command] = process.argv.slice(2);
  if (command === 'setup') {
    await pool.query(readFileSync(`${here}../migrations/016_list_notifications.sql`, 'utf8'));
    const c = await course();
    const acct = (await pool.query(`SELECT id FROM accounts ORDER BY created_at LIMIT 1`)).rows[0].id;
    await enrolReader(pool, acct, c.id, 'business analyst', new Date());
    console.log('migration 016 applied; sandbox reader enrolled in', c.id);
  } else if (command === 'status') {
    const c = await course();
    const rows = (await pool.query(`SELECT l.position, l.display_name, l.band, l.library_links, l.other_links, l.library_version FROM list_concepts l WHERE l.version_id = $1 ORDER BY l.position`, [c.published_version])).rows;
    console.log(`library version ${await libraryVersion(pool)}; course versions: ${(await pool.query(`SELECT version || ':' || status AS v FROM course_versions WHERE course_id = $1 ORDER BY version`, [c.id])).rows.map((r) => r.v).join(' ')}`);
    for (const r of rows) console.log(`${String(r.position + 1).padStart(2)}. [${r.band.padEnd(7)}] ${r.display_name}  (${r.library_links}L ${r.other_links}O, rated at library v${r.library_version})`);
    const changes = (await pool.query(`SELECT ch.kind, ch.summary, v.version FROM course_changes ch JOIN course_versions v ON v.id = ch.version_id WHERE ch.course_id = $1 ORDER BY v.version, ch.created_at`, [c.id])).rows;
    console.log(`announced changes (${changes.length}):`, ...changes.map((x) => `\n  v${x.version} ${x.kind}: ${x.summary}`));
    const acct = (await pool.query(`SELECT i.account_id FROM course_inputs i WHERE i.course_id = $1 LIMIT 1`, [c.id])).rows[0]?.account_id;
    if (acct) { const home = await createCourseReads(pool).home(acct, c.id); console.log('reader has_updates:', home.kind === 'ok' ? home.body.has_updates : home.kind); }
  } else if (command === 'refresh') console.log(JSON.stringify(await refreshListCourses(deps, SLUG)), `tokens ${tokens.in}/${tokens.out}`);
  else if (command === 'admit') { const r = await admitAndRate(deps, SLUG); console.log(JSON.stringify({ admitted: r.admission.admitted, kept: r.admission.kept, rejected: r.admission.rejected, version: r.admission.version, lists: r.lists }, null, 1), `tokens ${tokens.in}/${tokens.out}`); }
  else if (command === 'audit') { const r = await auditAndRate(deps, SLUG); console.log(JSON.stringify({ removed: r.removed.map((x) => x.id), lists: r.lists }), `tokens ${tokens.in}/${tokens.out}`); }
  else if (command === 'source') { const [, id, status, ...why] = process.argv.slice(2); console.log(await setSourceStatus(pool, id!, status!, why.join(' ') || 'sandbox check'), 'library version', await libraryVersion(pool)); }
  else console.log('usage: baListRefresh.ts setup | status | refresh | admit | audit | source <id> <status> [reason]');
} finally {
  await pool.end();
}
