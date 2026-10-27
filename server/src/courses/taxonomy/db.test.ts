// Posting-driven library, step 2: the skill categories live in the database too, and a category the mapper proposes is saved as proposed.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { importTaxonomy, loadTaxonomyFromDb, proposeCategory } from './db.ts';
import { loadTaxonomy, validateTaxonomy } from './taxonomy.ts';

const { db } = useCourseDb('taxdb', { reset: ['library_sources', 'library_role_files', 'library_meta', 'library_changes', 'library_source_index', 'skill_taxonomies', 'skill_categories', 'library_source_categories', 'category_coverage'] });
const REAL = new URL('../../../reference-library/business-analyst/categories.json', import.meta.url).pathname;

db('the business analyst taxonomy imports and reads back as it was in the file, and importing again changes nothing', async (p) => {
  const t = loadTaxonomy(REAL);
  await importTaxonomy(p, 'business-analyst', t);
  await importTaxonomy(p, 'business-analyst', t);
  const back = (await loadTaxonomyFromDb(p, 'business-analyst'))!;
  assert.deepEqual(back.categories.map(({ status, ...c }) => c), t.categories);
  assert.deepEqual([back.tools, back.examples, back.role], [t.tools, t.examples, t.role]);
  assert.deepEqual(validateTaxonomy(back), []);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM skill_categories`)).rows[0].n, t.categories.length);
});

db('a proposed category is saved once, as proposed, never over an existing id, and is read back with the others', async (p) => {
  await importTaxonomy(p, 'business-analyst', loadTaxonomy(REAL));
  assert.equal(await proposeCategory(p, 'business-analyst', { id: 'evaluating-ai-output', name: 'Evaluating AI output', description: 'checking what an AI tool produced before it is used', aliases: [] }), 'added');
  assert.equal(await proposeCategory(p, 'business-analyst', { id: 'evaluating-ai-output', name: 'Evaluating AI output', description: 'x', aliases: [] }), 'exists');
  assert.equal(await proposeCategory(p, 'business-analyst', { id: 'sql-data-querying', name: 'Other', description: 'x', aliases: [] }), 'exists');
  const back = (await loadTaxonomyFromDb(p, 'business-analyst'))!;
  assert.equal(back.categories.find((c) => c.id === 'evaluating-ai-output')!.status, 'proposed');
  assert.equal(back.categories.find((c) => c.id === 'sql-data-querying')!.status, 'active');
  await assert.rejects(proposeCategory(p, 'business-analyst', { id: 'Bad Id', name: 'x', description: 'x', aliases: [] }), /id/);
  await assert.rejects(proposeCategory(p, 'business-analyst', { id: 'workday-reports', name: 'Workday', description: 'x', aliases: [] }), /tool/);
});

db('a role with no taxonomy in the database reads as nothing, not an error', async (p) => {
  assert.equal(await loadTaxonomyFromDb(p, 'nobody'), null);
});

db('the taxonomy exports to a categories.json that loads back with the proposed category and its status', async (p) => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { exportTaxonomy } = await import('./db.ts');
  await importTaxonomy(p, 'business-analyst', loadTaxonomy(REAL));
  await proposeCategory(p, 'business-analyst', { id: 'evaluating-ai-output', name: 'Evaluating AI output', description: 'checking AI output', aliases: [] });
  const out = mkdtempSync(join(tmpdir(), 'tax-out-'));
  try {
    const file = await exportTaxonomy(p, 'business-analyst', out);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(back.categories.find((c: { id: string }) => c.id === 'evaluating-ai-output').status, 'proposed');
    assert.equal(back.categories.length, loadTaxonomy(REAL).categories.length + 1);
    assert.deepEqual(back.tools, loadTaxonomy(REAL).tools);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

db('the terms a taxonomy leaves unplaced are kept with it and read back, and an export writes them', async (p) => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { exportTaxonomy } = await import('./db.ts');
  const t = { ...loadTaxonomy(REAL), unplaced: ['apache spark', 'active directory'] };
  await importTaxonomy(p, 'business-analyst', t);
  assert.deepEqual((await loadTaxonomyFromDb(p, 'business-analyst'))!.unplaced, ['apache spark', 'active directory']);
  await importTaxonomy(p, 'business-analyst', { ...t, unplaced: ['apache spark'] });
  assert.deepEqual((await loadTaxonomyFromDb(p, 'business-analyst'))!.unplaced, ['apache spark'], 'importing again replaces the list');
  const out = mkdtempSync(join(tmpdir(), 'tax-unplaced-'));
  try {
    assert.deepEqual(JSON.parse(readFileSync(await exportTaxonomy(p, 'business-analyst', out), 'utf8')).unplaced, ['apache spark']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
