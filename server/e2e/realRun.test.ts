// The real-data API for a real end-to-end course build: the same API as the e2e server, with the fake "Test reader" sign-in, but over an existing schema (the p4_run sandbox) instead of
// a throwaway one. It must never reset, drop or empty anything, and it refuses a database it should not be run on. Real SQL in schemas made for the test; skipped when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createRealRunServer } from './realRun.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const full = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const made: string[] = [];
let skip: string | false = false;
let admin: pg.Pool;
const inSchema = (schema: string) => `${url.split('?')[0]}?options=-c%20search_path%3D${schema}`;

before(async () => {
  admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch {
    skip = 'no database reachable';
  }
});
after(async () => {
  if (!skip) for (const s of made) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await admin.end();
});

/** A schema like the sandbox: the whole of schema.sql (or just what came before part 12, to stand in for one that has not had migration 020). */
async function sandbox(sql = full) {
  const name = `realrun_${process.pid}_${Date.now()}_${made.length}`;
  made.push(name);
  await admin.query(`CREATE SCHEMA ${name}`);
  const p = new pg.Pool({ connectionString: inSchema(name), max: 1 });
  await p.query(sql);
  await p.end();
  return name;
}
const t = (name: string, fn: () => Promise<void>) => test(name, async (ctx) => (skip ? ctx.skip(skip) : fn()));
const post = (server: Awaited<ReturnType<typeof createRealRunServer>>, path: string, payload: unknown) =>
  server.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

t('it refuses the public schema, so it can never be run on the app\'s own tables by mistake', async () => {
  await assert.rejects(createRealRunServer({ databaseUrl: url }), /public schema/i);
});

t('it refuses a schema that has no course tables, and one that has not had migration 020, saying which', async () => {
  const bare = `realrun_bare_${process.pid}_${Date.now()}`;
  made.push(bare);
  await admin.query(`CREATE SCHEMA ${bare}`);
  await assert.rejects(createRealRunServer({ databaseUrl: inSchema(bare) }), /no course tables/i);
  const old = await sandbox(full.slice(0, full.indexOf('-- Plan 16, part 12')));
  await assert.rejects(createRealRunServer({ databaseUrl: inSchema(old) }), /migration 020/i);
});

t('over a sandbox it starts, lets the test reader in, and serves the course routes for them', async () => {
  const schema = await sandbox();
  const server = await createRealRunServer({ databaseUrl: inSchema(schema) });
  try {
    assert.equal(server.schema, schema);
    const signIn = await post(server, '/auth/google', { id_token: 'e2e:tester@example.com' });
    assert.equal(signIn.json().status, 'approved');
    assert.match(signIn.json().account_ref, /^EXC-/);
    const stranger = await post(server, '/auth/google', { id_token: 'e2e:stranger@example.com' });
    assert.notEqual(stranger.json().status, 'approved', 'only the one test reader is let in');
    await admin.query(`INSERT INTO ${schema}.course_settings (key, value, updated_at) VALUES ('courses_off', 'false'::jsonb, now())`);
    const options = await server.app.inject({ method: 'GET', url: '/courses/options', headers: { authorization: `Bearer ${signIn.json().session_token}` } });
    assert.equal(options.statusCode, 200);
    assert.equal(options.json().roles.find((r: { name: string }) => r.name === 'business analyst').available, true);
  } finally {
    await server.stop();
  }
});

t('it has no reset, and it changes nothing that is already there: courses and settings stay exactly as they were, and stopping leaves the schema and its data', async () => {
  const schema = await sandbox();
  await admin.query(`INSERT INTO ${schema}.roles (name) VALUES ('product manager')`);
  await admin.query(`INSERT INTO ${schema}.courses (role_id, title, status, visibility, published_version) SELECT id, 'a published course', 'building', 'shared', NULL FROM ${schema}.roles`);
  await admin.query(`INSERT INTO ${schema}.course_settings (key, value, updated_at) VALUES ('cap.credits_total', '60'::jsonb, now())`);
  const before = (await admin.query(`SELECT (SELECT json_agg(c ORDER BY id) FROM ${schema}.courses c) AS courses, (SELECT json_agg(s ORDER BY key) FROM ${schema}.course_settings s) AS settings, (SELECT count(*)::int FROM ${schema}.roles) AS roles`)).rows[0];
  const server = await createRealRunServer({ databaseUrl: inSchema(schema) });
  await post(server, '/auth/google', { id_token: 'e2e:tester@example.com' });
  assert.equal((await server.app.inject({ method: 'POST', url: '/e2e/reset' })).statusCode, 404, 'there is no reset route');
  await server.stop();
  const after = (await admin.query(`SELECT (SELECT json_agg(c ORDER BY id) FROM ${schema}.courses c) AS courses, (SELECT json_agg(s ORDER BY key) FROM ${schema}.course_settings s) AS settings, (SELECT count(*)::int FROM ${schema}.roles) AS roles`)).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [schema])).rows[0].n, 1, 'the schema is still there');
});

t('it tells which schema it is working in, so the terminal shows where the data goes', async () => {
  const schema = await sandbox();
  const server = await createRealRunServer({ databaseUrl: inSchema(schema) });
  try {
    assert.equal(server.schema, schema);
  } finally {
    await server.stop();
  }
});
