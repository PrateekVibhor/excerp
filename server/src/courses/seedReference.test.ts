// Loading the business analyst reference data into a database that has none: the role, the tracked companies, the skill categories and the library. Plain inserts from files,
// all in one transaction, safe to run twice, business analyst only. Real SQL.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { seedReference } from './seedReference.ts';

const { db } = useCourseDb('seedref', { reset: ['roles', 'tracked_companies', 'library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage'] });

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true,
  applies_to: ['business-analyst'], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over,
});
const taxonomy = {
  role: 'business analyst', note: 'a note',
  categories: [
    { id: 'requirements-elicitation', name: 'Requirements elicitation', description: 'finding out what stakeholders need', aliases: ['requirements gathering'] },
    { id: 'sql-data-querying', name: 'SQL and data querying', description: 'asking a database questions', aliases: ['sql'] },
  ],
  tools: [{ name: 'Jira', aliases: [], category: 'requirements-elicitation' }],
  examples: [{ phrase: 'talk to users', category: 'requirements-elicitation' }],
  unplaced: ['team player'],
};
const companies = [
  { employer: 'Acme Bank', group: 'finance', domains: ['acme.example.com', 'jobs.acme.example.com'] },
  { employer: 'Globex', group: 'tech', domains: ['globex.example.com'] },
];

/** A seed folder: shared.json, business-analyst/{sources,categories}.json and tracked-companies.json, plus (when asked) a product manager folder that must be ignored. */
function bundle(extra: { productManager?: boolean; companies?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seedref-'));
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ note: 'shared note', sources: [entry('shared-a'), entry('shared-b')] }));
  mkdirSync(join(dir, 'business-analyst'));
  writeFileSync(join(dir, 'business-analyst', 'sources.json'), JSON.stringify({ role: 'business-analyst', built: '2026-10-16', rules: 'r', sources: [entry('own-1'), entry('own-2', { status: 'removed' })], uses_shared: ['shared-a', 'shared-b'], checked_and_excluded: [] }));
  writeFileSync(join(dir, 'business-analyst', 'categories.json'), JSON.stringify(taxonomy));
  writeFileSync(join(dir, 'tracked-companies.json'), JSON.stringify(extra.companies ?? companies));
  if (extra.productManager) {
    mkdirSync(join(dir, 'product-manager'));
    writeFileSync(join(dir, 'product-manager', 'sources.json'), JSON.stringify({ role: 'product-manager', built: '2026-10-16', sources: [entry('pm-only', { applies_to: ['product-manager'] })], uses_shared: ['shared-a'], checked_and_excluded: [] }));
    writeFileSync(join(dir, 'product-manager', 'categories.json'), JSON.stringify({ ...taxonomy, role: 'product manager' }));
  }
  return dir;
}
const TABLES = ['roles', 'tracked_companies', 'skill_taxonomies', 'skill_categories', 'library_sources', 'library_role_files', 'library_meta', 'library_changes'];
/** What is in every table the loader writes to, as a count and a fingerprint of the rows. */
async function fingerprint(p: pg.Pool) {
  const out: Record<string, string> = {};
  for (const t of TABLES) out[t] = (await p.query(`SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS f FROM ${t} x`)).rows[0].f;
  return out;
}
const count = async (p: pg.Pool, t: string) => Number((await p.query(`SELECT count(*) FROM ${t}`)).rows[0].count);

db('an empty database gets the business analyst role, its tracked companies, its skill categories and its library, and the report says how many', async (p) => {
  const dir = bundle();
  try {
    const r = await seedReference(p, { dir });
    assert.deepEqual([r.role, r.companies.added, r.companies.present, r.taxonomy, r.categories, r.library.added, r.library.unchanged], ['added', 3, 0, 'added', 2, 4, 0]);
    assert.deepEqual((await p.query(`SELECT name, description FROM roles`)).rows, [{ name: 'business analyst', description: '' }]);
    assert.equal(await count(p, 'tracked_companies'), 3);
    assert.deepEqual((await p.query(`SELECT DISTINCT status, added_by FROM tracked_companies`)).rows, [{ status: 'candidate', added_by: 'seed' }]);
    assert.deepEqual((await p.query(`SELECT employer, domain FROM tracked_companies ORDER BY domain`)).rows[0], { employer: 'Acme Bank', domain: 'acme.example.com' });
    assert.equal(await count(p, 'skill_categories'), 2);
    assert.equal(await count(p, 'skill_taxonomies'), 1);
    assert.deepEqual((await p.query(`SELECT scope, count(*)::int AS n FROM library_sources GROUP BY scope ORDER BY scope`)).rows, [{ scope: 'business-analyst', n: 2 }, { scope: 'shared', n: 2 }]);
    assert.equal(await count(p, 'library_role_files'), 1);
    assert.equal(await count(p, 'library_changes'), 4);
    assert.equal(r.library.version, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('running it again changes nothing, in any table, and reports nothing added', async (p) => {
  const dir = bundle();
  try {
    await seedReference(p, { dir });
    const before = await fingerprint(p);
    const again = await seedReference(p, { dir });
    assert.deepEqual(await fingerprint(p), before);
    assert.deepEqual([again.role, again.companies.added, again.companies.present, again.taxonomy, again.library.added, again.library.unchanged], ['present', 0, 3, 'present', 0, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('it is all or nothing: a failure at the last step leaves every table as it was', async (p) => {
  const dir = bundle({ companies: [{ employer: 'Acme Bank', group: 'finance', domains: ['acme.example.com'] }, { group: 'tech', domains: ['broken.example.com'] }] });
  try {
    const before = await fingerprint(p);
    await assert.rejects(seedReference(p, { dir }), /employer/);
    assert.deepEqual(await fingerprint(p), before);
    assert.equal(await count(p, 'library_sources'), 0, 'the library that was loaded before the failure was rolled back');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('a dry run reports what it would load and leaves the database exactly as it was', async (p) => {
  const dir = bundle();
  try {
    const before = await fingerprint(p);
    const r = await seedReference(p, { dir, dryRun: true });
    assert.deepEqual([r.dryRun, r.library.added, r.companies.added, r.categories], [true, 4, 3, 2]);
    assert.deepEqual(await fingerprint(p), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('only the business analyst is loaded, even when the folder holds another role', async (p) => {
  const dir = bundle({ productManager: true });
  try {
    await seedReference(p, { dir });
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM library_sources WHERE id = 'pm-only'`)).rows[0].n, 0);
    assert.deepEqual((await p.query(`SELECT role_slug FROM library_role_files`)).rows, [{ role_slug: 'business-analyst' }]);
    assert.deepEqual((await p.query(`SELECT role_slug FROM skill_taxonomies`)).rows, [{ role_slug: 'business-analyst' }]);
    assert.deepEqual((await p.query(`SELECT name FROM roles`)).rows, [{ name: 'business analyst' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('what a person has changed since is never undone: a taxonomy that is there, a company already trusted and a source that differs are left as they are, and a differing source stops the run', async (p) => {
  const dir = bundle();
  try {
    await seedReference(p, { dir });
    await p.query(`UPDATE skill_categories SET name = 'Eliciting requirements' WHERE id = 'requirements-elicitation'`);
    await p.query(`UPDATE tracked_companies SET status = 'trusted', successes = 5 WHERE domain = 'acme.example.com'`);
    const before = await fingerprint(p);
    await seedReference(p, { dir });
    assert.deepEqual(await fingerprint(p), before, 'a second run does not touch the edits');
    writeFileSync(join(dir, 'business-analyst', 'sources.json'), JSON.stringify({ role: 'business-analyst', built: '2026-10-16', rules: 'r', sources: [entry('own-1', { name: 'A different name' }), entry('own-2', { status: 'removed' })], uses_shared: ['shared-a', 'shared-b'], checked_and_excluded: [] }));
    await assert.rejects(seedReference(p, { dir }), /already in the database but differ/);
    assert.deepEqual(await fingerprint(p), before, 'a source that differs stops the run and nothing is changed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('files that are not valid stop the run before anything is written', async (p) => {
  const dir = bundle();
  try {
    writeFileSync(join(dir, 'business-analyst', 'sources.json'), JSON.stringify({ role: 'business-analyst', built: 'x', sources: [entry('own-1', { tier: 9 })], uses_shared: [], checked_and_excluded: [] }));
    await assert.rejects(seedReference(p, { dir }), /library/i);
    writeFileSync(join(dir, 'business-analyst', 'sources.json'), JSON.stringify({ role: 'business-analyst', built: 'x', sources: [entry('own-1')], uses_shared: [], checked_and_excluded: [] }));
    writeFileSync(join(dir, 'business-analyst', 'categories.json'), JSON.stringify({ ...taxonomy, categories: [{ ...taxonomy.categories[0]!, id: 'Not Kebab' }] }));
    await assert.rejects(seedReference(p, { dir }), /taxonomy/i);
    for (const t of TABLES) assert.equal(await count(p, t), 0, `${t} is still empty`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

db('the real business analyst files in the repository load cleanly, and they are what production holds: 24 categories, 87 company domains, and 36 sources (11 business analyst, 2 of them removed, and 25 shared)', async (p) => {
  const repo = new URL('../../', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'seedref-real-'));
  try {
    copyFileSync(join(repo, 'reference-library/shared.json'), join(dir, 'shared.json'));
    mkdirSync(join(dir, 'business-analyst'));
    copyFileSync(join(repo, 'reference-library/business-analyst/sources.json'), join(dir, 'business-analyst/sources.json'));
    copyFileSync(join(repo, 'reference-library/business-analyst/categories.json'), join(dir, 'business-analyst/categories.json'));
    copyFileSync(join(repo, 'research/seedCompanies.json'), join(dir, 'tracked-companies.json'));
    const r = await seedReference(p, { dir });
    assert.deepEqual([r.categories, r.companies.added, r.library.added], [24, 87, 36]);
    assert.deepEqual((await p.query(`SELECT scope, count(*)::int AS n FROM library_sources GROUP BY scope ORDER BY scope`)).rows, [{ scope: 'business-analyst', n: 11 }, { scope: 'shared', n: 25 }]);
    assert.deepEqual((await p.query(`SELECT status, count(*)::int AS n FROM library_sources GROUP BY status ORDER BY status`)).rows, [{ status: 'active', n: 34 }, { status: 'removed', n: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
