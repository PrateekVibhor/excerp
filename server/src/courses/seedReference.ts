// Loads the business analyst reference data into a database that has none: the role, the tracked companies, the skill categories and the library (its sources and
// the shared ones they use). Plain inserts from files, no network, no model, no search, so no credits. All in one transaction (a failure anywhere leaves the database
// as it was), safe to run twice (what is already there is left alone, and a source that differs from the file stops the run), business analyst only.
// Run it with `node src/courses/seedReference.ts --dir <folder> [--dry-run]`; the folder holds shared.json, business-analyst/sources.json, business-analyst/categories.json
// and tracked-companies.json. It prints counts only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { importLibrary } from './library/db.ts';
import { loadLibrary, validateLibrary } from './library/load.ts';
import { importTaxonomy } from './taxonomy/db.ts';
import { loadTaxonomy, validateTaxonomy } from './taxonomy/taxonomy.ts';

const SLUG = 'business-analyst';
const ROLE = 'business analyst';

export interface SeedReport {
  dryRun: boolean;
  role: 'added' | 'present';
  companies: { added: number; present: number };
  taxonomy: 'added' | 'present';
  categories: number;
  library: { added: number; unchanged: number; version: number };
}

/** The loaders open and close their own transactions; this hands them one that ignores BEGIN, COMMIT and ROLLBACK, so the whole load is the caller's single transaction. */
function inside(client: pg.PoolClient): pg.Pool {
  const wrapped = {
    query: (sql: unknown, params?: unknown) => (typeof sql === 'string' && /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim()) ? Promise.resolve({ rows: [], rowCount: 0 }) : (client.query as (a: unknown, b?: unknown) => Promise<unknown>)(sql, params)),
    release: () => {},
  };
  return { connect: async () => wrapped, query: wrapped.query } as unknown as pg.Pool;
}

export async function seedReference(pool: pg.Pool, opts: { dir: string; dryRun?: boolean }): Promise<SeedReport> {
  const { dir, dryRun = false } = opts;
  // Read and check every file before anything is written.
  const all = loadLibrary(dir);
  const file = all.roles[SLUG];
  if (!file) throw new Error(`no ${SLUG}/sources.json in ${dir}`);
  const probe = { shared: all.shared.filter((s) => file.uses_shared.includes(s.id)), roles: { [SLUG]: file } };
  const library = validateLibrary(probe).errors;
  if (library.length) throw new Error(`the library files are not valid: ${library[0]!.where}: ${library[0]!.message}`);
  const taxonomy = loadTaxonomy(join(dir, SLUG, 'categories.json'));
  const taxonomyErrors = validateTaxonomy(taxonomy);
  if (taxonomyErrors.length) throw new Error(`the taxonomy file is not valid: ${taxonomyErrors[0]}`);
  const companies = JSON.parse(readFileSync(join(dir, 'tracked-companies.json'), 'utf8')) as Array<{ employer: string; domains: string[] }>;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = (await client.query(`INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [ROLE])).rowCount === 1 ? 'added' : 'present';
    const lib = await importLibrary(inside(client), dir, [SLUG]);
    if (lib.changed > 0) throw new Error(`${lib.changed} sources are already in the database but differ from the files; nothing was changed`);
    const hadTaxonomy = (await client.query(`SELECT 1 FROM skill_taxonomies WHERE role_slug = $1`, [SLUG])).rowCount === 1;
    if (!hadTaxonomy) await importTaxonomy(inside(client), SLUG, taxonomy);
    const tracked = { added: 0, present: 0 };
    for (const c of companies) {
      for (const domain of c.domains) {
        const r = await client.query(`INSERT INTO tracked_companies (employer, domain, added_by) VALUES ($1, $2, 'seed') ON CONFLICT (domain) DO NOTHING`, [c.employer, domain.trim().toLowerCase()]);
        tracked[r.rowCount === 1 ? 'added' : 'present']++;
      }
    }
    const categories = Number((await client.query(`SELECT count(*) FROM skill_categories WHERE role_slug = $1`, [SLUG])).rows[0].count);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { dryRun, role, companies: tracked, taxonomy: hadTaxonomy ? 'present' : 'added', categories, library: { added: lib.added, unchanged: lib.unchanged, version: lib.version } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args[args.indexOf('--dir') + 1];
  const url = process.env.DATABASE_URL;
  if (!dir || args.indexOf('--dir') < 0 || !url) {
    console.error('Usage: DATABASE_URL=... node src/courses/seedReference.ts --dir <folder> [--dry-run]');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    const r = await seedReference(pool, { dir, dryRun: args.includes('--dry-run') });
    console.log(r.dryRun ? 'DRY RUN: nothing was written. This is what a real run would do.' : 'Loaded.');
    console.log(`role "${ROLE}": ${r.role}`);
    console.log(`tracked companies: ${r.companies.added} added, ${r.companies.present} already there`);
    console.log(`skill taxonomy: ${r.taxonomy} (${r.categories} categories in the database)`);
    console.log(`library: ${r.library.added} sources added, ${r.library.unchanged} unchanged${r.dryRun ? '' : `, library version ${r.library.version}`}`);
  } catch (error) {
    const message = (error as Error).message ?? '';
    console.error(/ECONNREFUSED|ENOTFOUND|timeout|password|authentication/i.test(message) ? 'The database could not be reached.' : `Nothing was changed. ${message.split('\n')[0]}`); // never echo connection details
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
