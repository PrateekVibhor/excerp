// The list-course demo server: the e2e server with the course routes on and a reader (tester@example.com) who has six skills lists in different states, so the app's tab, panel
// and screens can be walked through on a simulator. Controls change what the reader sees. Real SQL in a throwaway schema; skipped when no database is reachable.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createListDemoServer } from './listDemo.ts';
import type { E2eServer } from './server.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/swipy';
let skip: string | false = false;
let server: E2eServer;

before(async () => {
  const probe = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await probe.query('SELECT 1');
  } catch {
    skip = 'no database reachable';
    return;
  } finally {
    await probe.end();
  }
  server = await createListDemoServer({ databaseUrl: url });
});
after(async () => {
  if (server) await server.stop();
});

const t = (name: string, fn: () => Promise<void>) =>
  test(name, async (ctx) => {
    if (skip) return ctx.skip(skip);
    await server.app.inject({ method: 'POST', url: '/e2e/demo/reset' });
    await fn();
  });

const call = async (token: string | undefined, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
  server.app.inject({ method, url: path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
const demo = (path: string, payload?: unknown) => call(undefined, 'POST', path, payload ?? {});
const signIn = async () => (await (await server.app.inject({ method: 'POST', url: '/auth/google', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ id_token: 'e2e:tester@example.com' }) })).json()).session_token as string;
type Mine = { id: string; role: string; status: string; visibility: string; independent: boolean; industry_label: string | null; custom_title: string | null; last_active_at: string; coverage: { total: number; strong: number; thin: number; missing: number } | null; has_updates?: boolean; refreshing: boolean; checked_at: string | null };
const mine = async (token: string) => (await call(token, 'GET', '/me/courses')).json().courses as Mine[];
const HOUR = 3_600_000;
const ageHours = (l: Mine) => (Date.now() - Date.parse(l.last_active_at)) / HOUR;

t('the approved test reader starts with six lists in different states, in the order they were last used', async () => {
  const token = await signIn();
  const lists = await mine(token);
  assert.equal(lists.length, 6);
  assert.deepEqual(lists.map((l) => l.status), ['ready', 'building', 'ready', 'ready', 'failed', 'ready']);
  assert.deepEqual(lists.map((l) => l.custom_title), ['Treasury systems role', null, null, 'Hospital data analyst', null, null]);
  assert.deepEqual(lists.map((l) => l.visibility), ['private', 'private', 'shared', 'private', 'private', 'private']);
  assert.deepEqual(lists.map((l) => l.independent), [true, true, false, true, true, true]);
  const ages = lists.map(ageHours);
  assert.ok(ages.every((a, i) => i === 0 || a >= ages[i - 1]!), 'newest use first');
});

t('they span every group of the panel: today, yesterday, the last week and older', async () => {
  const lists = await mine(await signIn());
  const day = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = day(new Date().toISOString());
  const ago = lists.map((l) => Math.round((today - day(l.last_active_at)) / 86_400_000));
  assert.deepEqual(ago.slice(0, 2), [0, 0]);
  assert.equal(ago[2], 1);
  assert.ok(ago[3]! >= 2 && ago[3]! <= 7 && ago[4]! >= 2 && ago[4]! <= 7);
  assert.ok(ago[5]! > 7);
});

t('what each list shows: new coverage on the first, a building list with no coverage yet, a shared list, a mostly-missing list, a failed one and an old one', async () => {
  const lists = await mine(await signIn());
  assert.deepEqual(lists[0]!.coverage, { total: 10, strong: 5, thin: 3, missing: 2 });
  assert.equal(lists[0]!.has_updates, true);
  assert.equal(lists[1]!.coverage, null);
  assert.deepEqual([lists[2]!.has_updates, lists[2]!.industry_label], [false, 'Fintech']);
  assert.ok(lists[3]!.coverage!.missing >= 6 && lists[3]!.industry_label === 'Healthcare');
  assert.equal(lists[4]!.coverage, null);
  assert.ok(lists[5]!.coverage!.total === 10 && lists[5]!.industry_label === null);
});

t('the building list shows its stage on the building screen, and a control moves it along', async () => {
  const token = await signIn();
  const id = (await mine(token))[1]!.id;
  assert.deepEqual(await call(token, 'GET', `/courses/${id}`).then((r) => { const j = r.json(); return [j.status, j.stage, j.percent]; }), ['building', 'reference', 62]);
  assert.equal((await demo('/e2e/demo/building', { stage: 'list', percent: 90 })).statusCode, 200);
  assert.deepEqual(await call(token, 'GET', `/courses/${id}`).then((r) => { const j = r.json(); return [j.stage, j.percent]; }), ['list', 90]);
  assert.equal((await demo('/e2e/demo/building', { stage: 'nonsense', percent: 5 })).statusCode, 400);
  assert.equal((await demo('/e2e/demo/building', { stage: 'read', percent: 500 })).statusCode, 400);
});

t('finishing the building list makes it a ready list with its concepts', async () => {
  const token = await signIn();
  const id = (await mine(token))[1]!.id;
  assert.equal((await demo('/e2e/demo/finish-building')).statusCode, 200);
  const home = (await call(token, 'GET', `/courses/${id}`)).json();
  assert.equal(home.status, 'ready');
  assert.ok(home.concepts.length >= 8);
  assert.deepEqual((await mine(token)).map((l) => l.status), ['ready', 'ready', 'ready', 'ready', 'failed', 'ready']);
});

t('the reader can be left with no lists at all, and a reset brings the six back', async () => {
  const token = await signIn();
  assert.equal((await demo('/e2e/demo/none')).statusCode, 200);
  assert.deepEqual(await mine(token), []);
  await demo('/e2e/demo/reset');
  assert.equal((await mine(token)).length, 6);
});

t('the overall credit cap can be switched on, which refuses a new list with credit_cap, and off again', async () => {
  const token = await signIn();
  const ask = () => call(token, 'POST', '/courses', { role: 'business analyst', mode: 'list', text: 'Business analyst posting. Skills: SQL.' });
  assert.equal((await demo('/e2e/demo/cap', { on: true })).statusCode, 200);
  const refused = await ask();
  assert.deepEqual([refused.statusCode, refused.json().error], [429, 'credit_cap']);
  assert.equal((await demo('/e2e/demo/cap', { on: false })).statusCode, 200);
  assert.equal((await ask()).statusCode, 202);
  assert.equal((await demo('/e2e/demo/cap', { on: 'yes' })).statusCode, 400);
});

t('refresh now: instant "up to date" until the library changes; then a check is queued, shown as checking, and a control finishes it', async () => {
  const token = await signIn();
  const id = (await mine(token))[0]!.id;
  const first = await call(token, 'POST', `/courses/${id}/refresh`, {});
  assert.deepEqual([first.statusCode, first.json().status], [200, 'up_to_date']);
  assert.equal((await demo('/e2e/demo/library-update')).statusCode, 200);
  const queued = await call(token, 'POST', `/courses/${id}/refresh`, {});
  assert.deepEqual([queued.statusCode, queued.json().status], [202, 'queued']);
  assert.equal((await mine(token)).find((l) => l.id === id)!.refreshing, true);
  const again = await call(token, 'POST', `/courses/${id}/refresh`, {});
  assert.equal(again.json().repeat, true);
  assert.equal((await demo('/e2e/demo/checking-done')).statusCode, 200);
  const after = (await mine(token)).find((l) => l.id === id)!;
  assert.deepEqual([after.refreshing, after.checked_at !== null], [false, true]);
  const limited = await call(token, 'POST', `/courses/${id}/refresh`, {});
  assert.deepEqual([limited.statusCode, limited.json().error], [429, 'refresh_limit']);
});

t('finishing a check can find new coverage, which puts the dot back on that list', async () => {
  const token = await signIn();
  const id = (await mine(token))[2]!.id; // the shared list, which starts with nothing new
  assert.equal((await mine(token)).find((l) => l.id === id)!.has_updates, false);
  await demo('/e2e/demo/library-update');
  await call(token, 'POST', `/courses/${id}/refresh`, {});
  await demo('/e2e/demo/checking-done', { rise: true });
  assert.equal((await mine(token)).find((l) => l.id === id)!.has_updates, true);
  const changes = (await call(token, 'GET', `/courses/${id}/changes?since=0`)).json();
  assert.match(changes.changes.at(-1).summary, /now thin, with 1 vetted source \(was missing\)$/);
});

t('renaming, opening and deleting work on these lists as on any: deleting the shared one leaves the list itself', async () => {
  const token = await signIn();
  const [first, , shared] = await mine(token);
  assert.equal((await call(token, 'PATCH', `/me/courses/${shared!.id}`, { title: 'My fintech list' })).statusCode, 204);
  assert.equal((await mine(token)).find((l) => l.id === shared!.id)!.custom_title, 'My fintech list');
  assert.equal((await call(token, 'POST', `/me/courses/${shared!.id}/open`)).statusCode, 204);
  assert.equal((await mine(token))[0]!.id, shared!.id, 'opening puts it first');
  assert.equal((await call(token, 'DELETE', `/me/courses/${shared!.id}`)).statusCode, 204);
  assert.equal((await mine(token)).some((l) => l.id === shared!.id), false);
  assert.equal((await server.pool.query(`SELECT count(*)::int AS n FROM courses WHERE id = $1`, [shared!.id])).rows[0].n, 1);
  assert.equal((await call(token, 'DELETE', `/me/courses/${first!.id}`)).statusCode, 204);
});

t('the sample links open a small placeholder page on the demo server, with the title escaped', async () => {
  const res = await server.app.inject({ method: 'GET', url: `/e2e/demo/page?t=${encodeURIComponent('<script>alert(1)</script> SQL guide')}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.ok(!res.body.includes('<script>'));
  assert.ok(res.body.includes('&lt;script&gt;'));
  assert.ok(res.body.includes('SQL guide'));
});

t('a list link in the seeded lists points at the demo server, never at a live address', async () => {
  const token = await signIn();
  const id = (await mine(token))[0]!.id;
  const home = (await call(token, 'GET', `/courses/${id}`)).json();
  const urls = home.concepts.flatMap((c: { resources: Array<{ url: string }> }) => c.resources.map((r) => r.url));
  assert.ok(urls.length > 8);
  assert.ok(urls.every((u: string) => u.startsWith('http://localhost:8787/e2e/demo/page')));
});

t('a check that finds new coverage can be finished more than once, on a list that already had a rise: each rise is a different concept', async () => {
  const token = await signIn();
  const first = (await mine(token))[0]!; // starts with one rise the reader has not seen
  for (const round of [1, 2]) {
    await demo('/e2e/demo/library-update');
    await server.pool.query(`UPDATE course_runs SET finished_at = now() WHERE kind = 'refresh'`);
    await server.pool.query(`DELETE FROM course_requests WHERE kind = 'refresh'`); // so the once-an-hour limit does not get in the way of the test
    const queued = await call(token, 'POST', `/courses/${first.id}/refresh`, {});
    assert.equal(queued.statusCode, 202, `round ${round}`);
    const done = await demo('/e2e/demo/checking-done', { rise: true });
    assert.equal(done.statusCode, 200, `round ${round}: ${done.body}`);
  }
  const changes = (await call(token, 'GET', `/courses/${first.id}/changes?since=0`)).json().changes as Array<{ target: string }>;
  assert.equal(new Set(changes.map((c) => c.target)).size, changes.length, 'no concept is announced twice for the same version');
  assert.ok(changes.length >= 3);
});
