// Posting-driven library, step 2: the library lives in the database. Import from the files, read back the same Library the file loader gives, export a
// snapshot that reads like the files, and count every change as a new library version. Real SQL.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { exportLibrary, importLibrary, libraryVersion, loadLibraryFromDb, saveSource, setSourceStatus } from './db.ts';
import { loadLibrary, sourcesFor, validateLibrary, type LibrarySource } from './load.ts';

const { db } = useCourseDb('librarydb', { reset: ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage'] });
const REAL = new URL('../../../reference-library', import.meta.url).pathname;

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true,
  applies_to: ['demo-role'], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
}) as LibrarySource;
/** A library folder with two roles; demo-role uses one shared source, other-role another. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'libdb-'));
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ note: 'shared note', sources: [entry('shared-a', { applies_to: ['demo-role', 'other-role'] }), entry('shared-b', { applies_to: ['other-role'] })] }, null, 2));
  for (const [slug, own, uses] of [['demo-role', ['own-1', 'own-2'], ['shared-a']], ['other-role', ['own-3'], ['shared-a', 'shared-b']]] as const) {
    mkdirSync(join(dir, slug));
    writeFileSync(join(dir, slug, 'sources.json'), JSON.stringify({ role: slug, built: '2026-10-16', rules: 'see README', sources: own.map((id) => entry(id, { applies_to: [slug] })), uses_shared: uses, checked_and_excluded: [{ name: 'Gated', url: null, reason: 'needs a login', date: '2026-10-16' }] }, null, 2));
  }
  return dir;
}

db('importing a role writes its own sources and the shared ones it uses, and reading them back gives the library the file loader gives', async (p) => {
  const dir = folder();
  try {
    const r = await importLibrary(p, dir, ['demo-role']);
    assert.deepEqual([r.added, r.changed, r.unchanged], [3, 0, 0]);
    const fromDb = await loadLibraryFromDb(p);
    const fromFiles = loadLibrary(dir);
    assert.deepEqual(Object.keys(fromDb.roles), ['demo-role'], 'only the imported role is in the database');
    assert.deepEqual(fromDb.shared.map((s) => s.id), ['shared-a'], 'only the shared source that role uses');
    assert.deepEqual(fromDb.roles['demo-role'], fromFiles.roles['demo-role']);
    assert.deepEqual(fromDb.shared[0], fromFiles.shared[0]);
    assert.deepEqual(sourcesFor(fromDb, 'demo-role').map((s) => s.id), ['own-1', 'own-2', 'shared-a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('importing again changes nothing and does not move the version; a changed entry is one change and one new version', async (p) => {
  const dir = folder();
  try {
    await importLibrary(p, dir, ['demo-role']);
    const v1 = await libraryVersion(p);
    assert.ok(v1 >= 3);
    const again = await importLibrary(p, dir, ['demo-role']);
    assert.deepEqual([again.added, again.changed, again.unchanged], [0, 0, 3]);
    assert.equal(await libraryVersion(p), v1);
    const file = JSON.parse(readFileSync(join(dir, 'demo-role', 'sources.json'), 'utf8'));
    file.sources[0].rationale = 'Trusted, and re-read.';
    writeFileSync(join(dir, 'demo-role', 'sources.json'), JSON.stringify(file));
    const third = await importLibrary(p, dir, ['demo-role']);
    assert.deepEqual([third.added, third.changed, third.unchanged], [0, 1, 2]);
    assert.equal(await libraryVersion(p), v1 + 1);
    assert.equal((await p.query(`SELECT kind FROM library_changes WHERE version = $1`, [v1 + 1])).rows[0].kind, 'changed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('the columns used for queries always agree with the whole entry kept beside them', async (p) => {
  const dir = folder();
  try {
    await importLibrary(p, dir, ['demo-role']);
    await setSourceStatus(p, 'own-1', 'flagged', 'a reader said it is the wrong field');
    const rows = (await p.query(`SELECT id, tier, status, url, access, next_check::text AS next_check, entry FROM library_sources`)).rows;
    assert.ok(rows.length === 3);
    for (const r of rows) assert.deepEqual([r.tier, r.status, r.url, r.access, r.next_check], [r.entry.tier, r.entry.status, r.entry.url, r.entry.access, r.entry.next_check], r.id);
    assert.equal(rows.find((r) => r.id === 'own-1')!.entry.status, 'flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a status change is a library version, and a source that is not active is no longer offered', async (p) => {
  const dir = folder();
  try {
    await importLibrary(p, dir, ['demo-role']);
    const before = await libraryVersion(p);
    await setSourceStatus(p, 'own-2', 'flagged', 'reported');
    assert.equal(await libraryVersion(p), before + 1);
    assert.equal((await p.query(`SELECT kind, summary FROM library_changes WHERE version = $1`, [before + 1])).rows[0].kind, 'status');
    assert.deepEqual(sourcesFor(await loadLibraryFromDb(p), 'demo-role').map((s) => s.id), ['own-1', 'shared-a']);
    await setSourceStatus(p, 'own-2', 'flagged', 'again'); // no change, no version
    assert.equal(await libraryVersion(p), before + 1);
    await assert.rejects(setSourceStatus(p, 'nope', 'flagged', 'x'), /no such source/);
    await assert.rejects(setSourceStatus(p, 'own-1', 'bogus', 'x'), /status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a new source is saved with its origin, becomes part of the role\'s library, and is one version', async (p) => {
  const dir = folder();
  try {
    await importLibrary(p, dir, ['demo-role']);
    const before = await libraryVersion(p);
    assert.equal(await saveSource(p, entry('found-1', { applies_to: ['demo-role'] }), 'demo-role', 'finder'), 'added');
    assert.equal(await saveSource(p, entry('found-1', { applies_to: ['demo-role'] }), 'demo-role', 'finder'), 'unchanged');
    assert.equal(await libraryVersion(p), before + 1);
    assert.deepEqual(sourcesFor(await loadLibrary_(p), 'demo-role').map((s) => s.id), ['own-1', 'own-2', 'found-1', 'shared-a']);
    assert.equal((await p.query(`SELECT origin FROM library_sources WHERE id = 'found-1'`)).rows[0].origin, 'finder');
    await assert.rejects(saveSource(p, entry('bad id!'), 'demo-role', 'finder'), /id/);
    await assert.rejects(saveSource(p, entry('no-role', { applies_to: ['someone-else'] }), 'demo-role', 'finder'), /applies_to/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const loadLibrary_ = (p: Parameters<typeof loadLibraryFromDb>[0]) => loadLibraryFromDb(p);

db('an export reads back as the same library, keeps entries in file order, and will not write over files of roles the database does not hold', async (p) => {
  const dir = folder();
  const out = mkdtempSync(join(tmpdir(), 'libdb-out-'));
  try {
    await importLibrary(p, dir, ['demo-role']);
    await saveSource(p, entry('found-1', { applies_to: ['demo-role'] }), 'demo-role', 'finder');
    const written = await exportLibrary(p, out);
    assert.ok(written.some((f) => f.endsWith('shared.json')) && written.some((f) => f.endsWith('demo-role/sources.json')));
    const back = loadLibrary(out);
    const db_ = await loadLibraryFromDb(p);
    assert.deepEqual(back, db_);
    assert.deepEqual(back.roles['demo-role']!.sources.map((s) => s.id), ['own-1', 'own-2', 'found-1']);
    assert.equal(JSON.parse(readFileSync(join(out, 'shared.json'), 'utf8')).note, 'shared note');
    assert.equal(JSON.parse(readFileSync(join(out, 'demo-role', 'sources.json'), 'utf8')).rules, 'see README', 'other keys of the file survive');
    // the original folder holds other-role too: exporting there would overwrite files the database knows nothing about
    await assert.rejects(exportLibrary(p, dir), /other-role/);
    assert.equal(loadLibrary(dir).roles['other-role']!.sources.length, 1, 'nothing was written there');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

db('the real business analyst library imports whole, passes the library check from the database, and exports a snapshot that reads back the same', async (p) => {
  const out = mkdtempSync(join(tmpdir(), 'libdb-real-'));
  try {
    const r = await importLibrary(p, REAL, ['business-analyst']);
    assert.equal(r.added, 36, 'eleven of its own (two of them removed) and 25 shared');
    const lib = await loadLibraryFromDb(p);
    assert.deepEqual(validateLibrary(lib).errors, []);
    assert.equal(sourcesFor(lib, 'business-analyst').length, 34, 'the nine active own sources and the 25 shared; the two removed ones are left out');
    const files = loadLibrary(REAL);
    assert.deepEqual(lib.roles['business-analyst'], files.roles['business-analyst']);
    await exportLibrary(p, out);
    assert.deepEqual(loadLibrary(out), lib);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
