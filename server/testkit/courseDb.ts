// A throwaway PostgreSQL schema built from schema.sql, for the course tests. Lives outside src/ so it is not part of the Docker
// image. Tests skip when no database is reachable (for example without DATABASE_URL).
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';

/** `reset`: tables to empty before each test, for tests that count across everything (caps, the request log, settings). */
export function useCourseDb(prefix: string, options: { reset?: string[] } = {}) {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  let pool: pg.Pool | undefined;
  let skip: string | false = false;

  before(async () => {
    const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
    } catch {
      skip = 'no database reachable';
      await admin.end();
      return;
    }
    await admin.end();
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  return {
    url,
    schema,
    /** A test that needs the database; skipped without one. */
    db: (name: string, run: (p: pg.Pool) => Promise<void>) =>
      test(name, async (t) => {
        if (skip) return t.skip(skip);
        if (options.reset?.length) await pool!.query(`TRUNCATE ${options.reset.join(', ')} CASCADE`);
        await run(pool!);
      }),
    /** The pool, for tests that need to read it directly. Only valid inside a test body. */
    pool: () => pool!,
    skipped: () => skip,
  };
}
