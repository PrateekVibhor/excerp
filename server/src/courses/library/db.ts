// Posting-driven library, step 2: the library in the database. The files under reference-library/ seed it and are written back as a snapshot for backup
// and audit; the database is what the system reads and writes. Every change to a source is one new library version (library_changes), which the
// coverage ratings are stamped with. The page text of a source is never stored here.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { loadLibrary, validateLibrary, type Library, type LibrarySource, type RoleFile } from './load.ts';

type Db = pg.Pool | pg.PoolClient;
export const SHARED = 'shared';
const STATUSES = ['active', 'candidate_other_roles', 'suspended', 'removed', 'flagged'];
export type SaveResult = 'added' | 'changed' | 'unchanged';

export async function libraryVersion(db: Db): Promise<number> {
  return Number((await db.query(`SELECT coalesce(max(version), 0) AS v FROM library_changes`)).rows[0].v);
}

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upsert(client: pg.PoolClient, entry: LibrarySource, scope: string, position: number, origin: 'seed' | 'finder'): Promise<SaveResult> {
  const old = (await client.query(`SELECT entry, scope FROM library_sources WHERE id = $1 FOR UPDATE`, [entry.id])).rows[0];
  const cols = [entry.id, scope, position, entry.name, entry.url, entry.tier, entry.layer, entry.access, entry.perspective, entry.pipeline_readable, entry.applies_to, entry.status, entry.next_check ?? null, JSON.stringify(entry)];
  if (!old) {
    await client.query(`INSERT INTO library_sources (id, scope, position, name, url, tier, layer, access, perspective, pipeline_readable, applies_to, status, next_check, entry, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`, [...cols, origin]);
    await client.query(`INSERT INTO library_changes (source_id, kind, summary) VALUES ($1, 'added', $2)`, [entry.id, `${origin}: ${entry.name}`.slice(0, 200)]);
    return 'added';
  }
  if (isDeepStrictEqual(old.entry, JSON.parse(JSON.stringify(entry))) && old.scope === scope) {
    await client.query(`UPDATE library_sources SET position = $2 WHERE id = $1 AND position <> $2`, [entry.id, position]); // order only: not a change
    return 'unchanged';
  }
  await client.query(`UPDATE library_sources SET scope=$2, position=$3, name=$4, url=$5, tier=$6, layer=$7, access=$8, perspective=$9, pipeline_readable=$10, applies_to=$11, status=$12, next_check=$13, entry=$14::jsonb, updated_at=now() WHERE id=$1`, cols);
  await client.query(`INSERT INTO library_changes (source_id, kind, summary) VALUES ($1, 'changed', $2)`, [entry.id, entry.name.slice(0, 200)]);
  return 'changed';
}

/** Copy the given roles' own sources, and the shared sources they use, from the files into the database. Running it again changes nothing that is the same. */
export async function importLibrary(pool: pg.Pool, dir: string, roles: string[]): Promise<{ added: number; changed: number; unchanged: number; version: number }> {
  const lib = loadLibrary(dir);
  const shared = JSON.parse(readFileSync(join(dir, 'shared.json'), 'utf8')) as { note?: string };
  const tally = { added: 0, changed: 0, unchanged: 0 };
  await inTransaction(pool, async (client) => {
    await client.query(`INSERT INTO library_meta (key, value) VALUES ('shared_note', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(shared.note ?? '')]);
    const sharedIndex = new Map(lib.shared.map((s, i) => [s.id, i]));
    for (const slug of roles) {
      const file = lib.roles[slug];
      if (!file) throw new Error(`no folder for role "${slug}" in ${dir}`);
      const raw = JSON.parse(readFileSync(join(dir, slug, 'sources.json'), 'utf8')) as Record<string, unknown>;
      const { role, built, sources, uses_shared, checked_and_excluded, ...extra } = raw;
      void role; void built; void sources; void uses_shared; void checked_and_excluded;
      await client.query(
        `INSERT INTO library_role_files (role_slug, role, built, uses_shared, checked_and_excluded, extra) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
         ON CONFLICT (role_slug) DO UPDATE SET role=EXCLUDED.role, built=EXCLUDED.built, uses_shared=EXCLUDED.uses_shared, checked_and_excluded=EXCLUDED.checked_and_excluded, extra=EXCLUDED.extra`,
        [slug, file.role, file.built, JSON.stringify(file.uses_shared), JSON.stringify(file.checked_and_excluded), JSON.stringify(extra)],
      );
      for (const [i, s] of file.sources.entries()) tally[await upsert(client, s, slug, i, 'seed')]++;
      for (const id of file.uses_shared) {
        const s = lib.shared.find((x) => x.id === id);
        if (s) tally[await upsert(client, s, SHARED, sharedIndex.get(id)!, 'seed')]++;
      }
    }
  });
  return { ...tally, version: await libraryVersion(pool) };
}

/** The library as the file loader gives it, for the roles in the database (or just the roles asked for). */
export async function loadLibraryFromDb(db: Db, roles?: string[]): Promise<Library> {
  const files = (await db.query(`SELECT * FROM library_role_files WHERE ($1::text[] IS NULL OR role_slug = ANY($1)) ORDER BY role_slug`, [roles ?? null])).rows;
  const rows = (await db.query(`SELECT scope, entry FROM library_sources ORDER BY position, id`)).rows as Array<{ scope: string; entry: LibrarySource }>;
  const usedShared = new Set(files.flatMap((f) => f.uses_shared as string[]));
  const out: Library = { shared: rows.filter((r) => r.scope === SHARED && usedShared.has(r.entry.id)).map((r) => r.entry), roles: {} };
  for (const f of files) {
    const file: RoleFile = { role: f.role, built: f.built, sources: rows.filter((r) => r.scope === f.role_slug).map((r) => r.entry), uses_shared: f.uses_shared, checked_and_excluded: f.checked_and_excluded };
    out.roles[f.role_slug] = file;
  }
  return out;
}

/** Save one source (a new one from the finder, or a changed one). It is checked against the library schema first; a failing entry is never stored. */
export async function saveSource(pool: pg.Pool, entry: LibrarySource, scope: string, origin: 'seed' | 'finder' = 'finder'): Promise<SaveResult> {
  const probe: Library = scope === SHARED ? { shared: [entry], roles: {} } : { shared: [], roles: { [scope]: { role: scope, built: '', sources: [entry], uses_shared: [], checked_and_excluded: [] } } };
  const first = validateLibrary(probe).errors[0];
  if (first) throw new Error(`${first.where}: ${first.message}`);
  return inTransaction(pool, async (client) => {
    const old = (await client.query(`SELECT position FROM library_sources WHERE id = $1`, [entry.id])).rows[0];
    const position = old ? old.position : Number((await client.query(`SELECT coalesce(max(position) + 1, 0) AS p FROM library_sources WHERE scope = $1`, [scope])).rows[0].p);
    return upsert(client, entry, scope, position, origin);
  });
}

/** Change a source's status (for example flagged by a reader). One library version; nothing happens when it already has that status. */
export async function setSourceStatus(pool: pg.Pool, id: string, status: string, reason: string): Promise<boolean> {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  return inTransaction(pool, async (client) => {
    const row = (await client.query(`SELECT entry FROM library_sources WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new Error(`no such source: ${id}`);
    if (row.entry.status === status) return false;
    await client.query(`UPDATE library_sources SET status = $2, entry = jsonb_set(entry, '{status}', to_jsonb($2::text)), updated_at = now() WHERE id = $1`, [id, status]);
    await client.query(`INSERT INTO library_changes (source_id, kind, summary) VALUES ($1, 'status', $2)`, [id, `${row.entry.status} -> ${status}: ${reason}`.slice(0, 300)]);
    return true;
  });
}

/** Write the database's library as files in the same layout, for backup or audit. It refuses a folder that holds roles the database does not, so the repository's own files can never be overwritten by a partial export. */
export async function exportLibrary(pool: pg.Pool, dir: string): Promise<string[]> {
  const lib = await loadLibraryFromDb(pool);
  const have = new Set(Object.keys(lib.roles));
  if (existsSync(dir)) {
    const foreign = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'sources.json')) && !have.has(n));
    if (foreign.length) throw new Error(`${dir} holds files for roles that are not in the database (${foreign.join(', ')}); export to an empty folder instead`);
  }
  const note = (await pool.query(`SELECT value FROM library_meta WHERE key = 'shared_note'`)).rows[0]?.value ?? '';
  const written: string[] = [];
  const write = (file: string, data: unknown) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    written.push(file);
  };
  write(join(dir, 'shared.json'), { note, sources: lib.shared });
  const extras = new Map((await pool.query(`SELECT role_slug, extra FROM library_role_files`)).rows.map((r) => [r.role_slug as string, r.extra as Record<string, unknown>]));
  for (const [slug, f] of Object.entries(lib.roles)) write(join(dir, slug, 'sources.json'), { role: f.role, built: f.built, ...extras.get(slug), sources: f.sources, uses_shared: f.uses_shared, checked_and_excluded: f.checked_and_excluded });
  return written;
}
