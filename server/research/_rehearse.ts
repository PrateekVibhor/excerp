/** Not committed: rehearse migrations 013-016 on a scratch copy of the sandbox's Plan 16 data (PM, FDE, BA, published courses) and prove no existing row changes. */
import { readFileSync } from 'node:fs';
import pg from 'pg';
const here = new URL('.', import.meta.url).pathname;
const SCRATCH = 'rehearsal_013';
const admin = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy' });
await admin.query(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCRATCH}`);
const pool = new pg.Pool({ connectionString: 'postgres://localhost:5432/swipy', options: `-c search_path=${SCRATCH}` });
try {
  const full = readFileSync(`${here}../schema.sql`, 'utf8');
  await pool.query(full.slice(0, full.indexOf('-- Plan 16, part 5'))); // the database as it is after migration 012
  const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`, [SCRATCH])).rows.map((r) => r.table_name as string);
  const cols = async (schema: string, t: string) => (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, t])).rows.map((r) => r.column_name as string);
  await pool.query('SET session_replication_role = replica');
  let copied = 0;
  for (const t of tables) {
    const mine = await cols(SCRATCH, t);
    const theirs = new Set(await cols('p4_run', t));
    const common = mine.filter((c) => theirs.has(c));
    if (!common.length) continue;
    const list = common.map((c) => `"${c}"`).join(', ');
    // the sandbox's list course, and what only exists because of these migrations, is left out: the rehearsal is of a database that has the narrative courses only
    const where = t === 'courses' ? `WHERE mode = 'narrow'` : common.includes('course_id') ? `WHERE course_id NOT IN (SELECT id FROM p4_run.courses WHERE mode = 'list')` : '';
    const r = await pool.query(`INSERT INTO ${SCRATCH}."${t}" (${list}) SELECT ${list} FROM p4_run."${t}" ${where}`);
    copied += r.rowCount ?? 0;
  }
  await pool.query('SET session_replication_role = DEFAULT');
  const fingerprint = async (colsByTable: Map<string, string[]>) => {
    const out = new Map<string, string>();
    for (const [t, c] of colsByTable) {
      const list = c.map((x) => `"${x}"`).join(', ');
      const r = await pool.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM (SELECT ${list} FROM "${t}") x`);
      out.set(t, `${r.rows[0].n} rows ${r.rows[0].h}`);
    }
    return out;
  };
  const colsByTable = new Map<string, string[]>();
  for (const t of tables) colsByTable.set(t, await cols(SCRATCH, t));
  const before = await fingerprint(colsByTable);
  const tablesBefore = new Set(tables);
  const colsBefore = new Map([...colsByTable].map(([t, c]) => [t, new Set(c)]));
  for (const f of ['013_library_db', '014_library_gaps', '015_list_mode', '016_list_notifications']) await pool.query(readFileSync(`${here}../migrations/${f}.sql`, 'utf8'));
  const after = await fingerprint(colsByTable); // the same tables, the same columns as before
  const changed = [...before].filter(([t, h]) => after.get(t) !== h).map(([t]) => t);
  const nonEmpty = [...before].filter(([, h]) => !h.startsWith('0 rows'));
  const nowTables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`, [SCRATCH])).rows.map((r) => r.table_name as string);
  const newTables = nowTables.filter((t) => !tablesBefore.has(t));
  const newCols: string[] = [];
  for (const t of tables) for (const c of await cols(SCRATCH, t)) if (!colsBefore.get(t)!.has(c)) newCols.push(`${t}.${c}`);
  console.log(`copied ${copied} rows from the sandbox into ${tables.length} existing tables (${nonEmpty.length} non-empty)`);
  console.log('non-empty tables fingerprinted before and after:', nonEmpty.map(([t, h]) => `${t}=${h.split(' ')[0]}`).join(', '));
  console.log('tables whose existing rows changed:', changed.length ? changed.join(', ') : 'NONE');
  console.log('new tables:', newTables.join(', '));
  console.log('new columns on existing tables:', newCols.join(', ') || 'none');
  // run them all a second time: nothing changes
  for (const f of ['013_library_db', '014_library_gaps', '015_list_mode', '016_list_notifications']) await pool.query(readFileSync(`${here}../migrations/${f}.sql`, 'utf8'));
  const again = await fingerprint(colsByTable);
  console.log('after running all four a second time, changed:', [...before].filter(([t, h]) => again.get(t) !== h).length ? 'SOME' : 'NONE');
  const per = ['courses', 'role_concepts', 'resources', 'concept_claims', 'course_versions', 'course_changes', 'course_concepts'].map((t) => `${t}=${before.get(t)?.split(' ')[0]}`);
  console.log('rows in the course tables that were rehearsed over:', per.join(', '));
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`);
  await admin.end();
}
