// The `allow` command against the real SQL, in a throwaway schema. Skipped when no database is reachable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { runAllowCommand } from './allowList.ts';
import { createAuthStore, type AuthStore } from './authStore.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
const schema = `allow_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let store: AuthStore;
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
  store = createAuthStore(pool);
});
after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await pool!.query('TRUNCATE allowed_emails, access_requests, sessions');
    await fn();
  });

/** Runs the command and returns what it printed and its exit code. */
async function run(...args: string[]) {
  const lines: string[] = [];
  const code = await runAllowCommand(args, store, (line) => lines.push(line));
  return { code, out: lines.join('\n') };
}

t('Scenario: Allow command - add, then list shows the email, then remove, then list does not', async () => {
  assert.equal((await run('add', 'a@b.com')).code, 0);
  assert.match((await run('list')).out, /a@b\.com/);
  assert.equal((await run('remove', 'a@b.com')).code, 0);
  assert.doesNotMatch((await run('list')).out, /a@b\.com/);
});

t('add says whether the email was new, and lower-cases it', async () => {
  assert.match((await run('add', 'Tester@Example.com')).out, /Added tester@example\.com/);
  assert.match((await run('add', 'tester@example.com')).out, /already/i);
});

t('remove says when the email was not on the list, and still succeeds', async () => {
  const res = await run('remove', 'nobody@example.com');
  assert.equal(res.code, 0);
  assert.match(res.out, /not on the list/i);
});

t('Scenario: Allow command - pending lists an email that asked but is not on the list, with when', async () => {
  await store.recordRequest('asked@example.com', new Date('2026-10-09T12:00:00.000Z'));
  await store.recordRequest('allowed@example.com', new Date('2026-10-09T12:00:00.000Z'));
  await store.addAllowed('allowed@example.com');
  const res = await run('pending');
  assert.match(res.out, /asked@example\.com/);
  assert.match(res.out, /2026-10-09/);
  assert.doesNotMatch(res.out, /allowed@example\.com/);
});

t('adding a waiting email takes it off the pending list', async () => {
  await store.recordRequest('asked@example.com', new Date());
  await run('add', 'asked@example.com');
  assert.match((await run('pending')).out, /no one is waiting/i);
});

t('empty lists say so', async () => {
  assert.match((await run('list')).out, /empty/i);
  assert.match((await run('pending')).out, /no one is waiting/i);
});

t('a bad command, a missing or invalid email, or extra words print the usage and fail', async () => {
  for (const args of [[], ['frobnicate'], ['add'], ['add', 'not-an-email'], ['remove'], ['list', 'extra'], ['add', 'a@b.com', 'extra']]) {
    const res = await run(...args);
    assert.equal(res.code, 1, args.join(' '));
    assert.match(res.out, /usage/i);
  }
  assert.equal((await store.listAllowed()).length, 0);
});
