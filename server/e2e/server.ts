// The server the end-to-end tests run against (spec 12). It is the real API from ../src with two differences: sign-in
// accepts "e2e:<email>" tokens instead of Google's, and /e2e routes let a flow reset it and change its state.
// It lives outside src/ on purpose: the production image copies only src/, so none of this is ever deployed.
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { mockArticles } from '../../src/data/mockArticles.ts';
import { buildApi } from '../src/api.ts';
import { InvalidTokenError, normalizeEmail, type TokenVerifier } from '../src/auth.ts';
import { createAccountStore } from '../src/accounts.ts';
import { createAuthStore } from '../src/authStore.ts';
import { createCourseActivity } from '../src/courses/activity.ts';
import { createCourseReads } from '../src/courses/reads.ts';
import { createCourseSettings } from '../src/courses/settings.ts';
import { createCourseStarts } from '../src/courses/starts.ts';
import { createArticleReader } from '../src/db.ts';
import { createLeaderboardStore, type LeaderboardStore } from '../src/leaderboard.ts';
import { createRateLimiter } from '../src/rateLimit.ts';

export const TEST_PREFIX = 'e2e:';
/** The reader every reset leaves on the allow-list. */
export const APPROVED_TEST_EMAIL = 'tester@example.com';

/** The sample article N (1 to 9) always has this id in the test database, so flows and tests can name it. */
export const articleId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** "e2e:<email>" is that email, verified, except "unverified@..." which Google would have flagged as not verified. Nothing else is accepted. */
export function createTestVerifier(): TokenVerifier {
  return async (idToken) => {
    if (typeof idToken !== 'string' || !idToken.startsWith(TEST_PREFIX)) throw new InvalidTokenError('not a test token');
    const email = normalizeEmail(idToken.slice(TEST_PREFIX.length));
    if (email === null || email !== idToken.slice(TEST_PREFIX.length)) throw new InvalidTokenError('not a test token'); // exactly the normal form, no spaces or capitals
    return { email, email_verified: !email.startsWith('unverified@'), sub: `e2e-sub-${email}` };
  };
}

export function courseDeps(pool: pg.Pool) {
  const settings = createCourseSettings(pool);
  const reads = createCourseReads(pool);
  return { reads, settings, starts: createCourseStarts(pool, settings), activity: createCourseActivity(pool, reads, settings) };
}

export interface E2eServer {
  app: ReturnType<typeof Fastify>;
  pool: pg.Pool;
  /** The throwaway schema everything lives in. */
  schema: string;
  listen(): Promise<{ host: string; port: number }>;
  /** Stops listening and drops the schema. */
  stop(): Promise<void>;
}

export async function createE2eServer({ databaseUrl, port = 8787, host = '127.0.0.1', courses = false }: { databaseUrl: string; port?: number; host?: string; /** Switch the accounts and course routes on (the list-course demo); the end-to-end flows leave them off. */ courses?: boolean }): Promise<E2eServer> {
  const schema = `e2e_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

  const auth = createAuthStore(pool);
  const board = createLeaderboardStore(pool);
  let leaderboardDown = false;
  // Only reading the board can be made to fail, so a quiz can still be verified while "the server is unreachable" is being tested.
  const leaderboard: LeaderboardStore = {
    record: (v, now) => board.record(v, now),
    deleteDevice: (device) => board.deleteDevice(device),
    leaderboard: async (device, limit) => {
      if (leaderboardDown) throw new Error('leaderboard switched off by a test');
      return board.leaderboard(device, limit);
    },
  };

  /** Empties everything, puts the nine sample articles back, and leaves the approved test reader on the allow-list. */
  async function reset() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE verifications, players, sessions, access_requests, allowed_emails, articles CASCADE');
      for (const [i, a] of mockArticles.entries()) {
        await client.query(
          `INSERT INTO articles (id, source_company, source_url, content_type, title, summary, published_at, fetched_at, reader_count, quiz, topic)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [articleId(i + 1), a.source_company, a.source_url, a.content_type, a.title, a.summary, a.published_at, a.fetched_at, a.reader_count, a.quiz ? JSON.stringify(a.quiz) : null, a.topic ?? null],
        );
      }
      await client.query('INSERT INTO allowed_emails (email) VALUES ($1)', [APPROVED_TEST_EMAIL]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    leaderboardDown = false;
  }
  await reset();

  // Generous limits: a run signs in as the same readers many times from this one machine.
  const loose = () => createRateLimiter({ max: 1_000_000, windowMs: 3_600_000 });
  const app = await buildApi({
    ping: async () => {
      await pool.query('SELECT 1');
    },
    articles: createArticleReader(pool),
    leaderboard,
    limiter: loose(),
    ipLimiter: loose(),
    auth: { verify: createTestVerifier(), store: auth, ipLimiter: loose(), emailLimiter: loose() },
    ...(courses ? { accounts: createAccountStore(pool), courses: courseDeps(pool) } : {}),
  });

  app.get('/e2e/ready', async () => ({ status: 'ready' }));
  app.post('/e2e/reset', async () => {
    await reset();
    return { status: 'reset' };
  });
  app.post<{ Body: { email?: unknown } }>('/e2e/allow', async (request, reply) => {
    const email = normalizeEmail((request.body as { email?: unknown } | null)?.email);
    if (email === null) return reply.code(400).send({ error: 'email must be an email address' });
    await auth.addAllowed(email);
    return { status: 'allowed', email };
  });
  app.post<{ Body: { down?: unknown } }>('/e2e/leaderboard-down', async (request, reply) => {
    const down = (request.body as { down?: unknown } | null)?.down;
    if (typeof down !== 'boolean') return reply.code(400).send({ error: 'down must be true or false' });
    leaderboardDown = down;
    return { status: 'ok', down };
  });

  // Stopping can be asked for twice at once (a Ctrl-C reaches this process and the script that started it), and the caller
  // exits the moment it returns. So every call gets the same promise, which resolves only after the schema is dropped.
  let stopping: Promise<void> | undefined;
  return {
    app,
    pool,
    schema,
    async listen() {
      await app.listen({ host, port });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('the test server has no address');
      return { host: address.address, port: address.port };
    },
    stop() {
      stopping ??= (async () => {
        await app.close();
        await pool.end();
        const cleanup = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        try {
          await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await cleanup.end();
        }
      })();
      return stopping;
    },
  };
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
  const port = Number(process.env.E2E_PORT ?? 8787);
  const server = await createE2eServer({ databaseUrl, port });
  const { host, port: bound } = await server.listen();
  console.log(`E2E test server ready on http://${host}:${bound} (schema ${server.schema})`);
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
