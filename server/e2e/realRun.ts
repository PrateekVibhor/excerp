// The API for a real end-to-end course build, with the fake "Test reader" sign-in, over an EXISTING schema (the p4_run sandbox) instead of a throwaway one: point DATABASE_URL at it with
// `?options=-c%20search_path%3Dp4_run`. Unlike the demo server it seeds nothing, resets nothing and drops nothing; the only thing it writes of its own is the test reader's place on the
// allow-list. It refuses the public schema (the app's own tables), a schema without the course tables, and one that has not had migration 020. Dev only: it lives outside src/, so the
// image never has it. Run it with `npm run demo:real`.
import Fastify from 'fastify';
import pg from 'pg';
import { createAccountStore } from '../src/accounts.ts';
import { buildApi } from '../src/api.ts';
import { createAuthStore } from '../src/authStore.ts';
import { createArticleReader } from '../src/db.ts';
import { createLeaderboardStore } from '../src/leaderboard.ts';
import { createRateLimiter } from '../src/rateLimit.ts';
import { APPROVED_TEST_EMAIL, courseDeps, createTestVerifier } from './server.ts';

export interface RealRunServer {
  app: ReturnType<typeof Fastify>;
  pool: pg.Pool;
  /** The schema everything is read from and written to. */
  schema: string;
  listen(): Promise<{ host: string; port: number }>;
  /** Stops listening and closes the connections. The schema and everything in it stay. */
  stop(): Promise<void>;
}

export async function createRealRunServer({ databaseUrl, port = 8787, host = '127.0.0.1' }: { databaseUrl: string; port?: number; host?: string }): Promise<RealRunServer> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const where = (await pool.query(
      `SELECT current_schema() AS schema, to_regclass('courses') IS NOT NULL AS courses,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'courses' AND column_name = 'independent') AS m020`,
    )).rows[0] as { schema: string; courses: boolean; m020: boolean };
    if (where.schema === 'public') throw new Error('Refusing to run on the public schema: point DATABASE_URL at a sandbox schema, for example postgres://localhost:5432/swipy?options=-c%20search_path%3Dp4_run');
    if (!where.courses) throw new Error(`There are no course tables in schema ${where.schema}: this needs a schema that has had the Plan 16 migrations`);
    if (!where.m020) throw new Error(`Migration 020 is not applied to schema ${where.schema}: run migrations/020_independent_lists.sql on it first`);

    await pool.query(`INSERT INTO allowed_emails (email) VALUES ($1) ON CONFLICT DO NOTHING`, [APPROVED_TEST_EMAIL]);
    const loose = () => createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 });
    const app = await buildApi({
      ping: async () => void (await pool.query('SELECT 1')),
      articles: createArticleReader(pool),
      leaderboard: createLeaderboardStore(pool),
      limiter: loose(),
      ipLimiter: loose(),
      auth: { verify: createTestVerifier(), store: createAuthStore(pool), ipLimiter: loose(), emailLimiter: loose() },
      accounts: createAccountStore(pool),
      courses: courseDeps(pool),
    });
    app.get('/e2e/ready', async () => ({ status: 'ready', schema: where.schema }));
    return {
      app,
      pool,
      schema: where.schema,
      async listen() {
        await app.listen({ host, port });
        const address = app.server.address();
        if (address === null || typeof address === 'string') throw new Error('the server has no address');
        return { host: address.address, port: address.port };
      },
      async stop() {
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const server = await createRealRunServer({ databaseUrl, port: Number(process.env.E2E_PORT ?? 8787) });
  const { host, port } = await server.listen();
  console.log(`Real-data API ready on http://${host}:${port}, working in schema ${server.schema} (nothing is reset or dropped). Sign in as "Test reader: approved".`);
  const courses = (await server.pool.query(`SELECT value FROM course_settings WHERE key = 'courses_off'`)).rows[0]?.value;
  if (courses !== false) console.log('NOTE: courses are OFF in this schema (setting courses_off is not false), so every course request will answer 503 courses_off.');
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
