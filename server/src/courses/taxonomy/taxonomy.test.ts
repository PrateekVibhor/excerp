// Posting-driven library, step 1: the skill categories a business analyst posting maps to, and the tools that map to a transferable skill instead of
// becoming one. The seed is data; these tests hold it to its own rules so a bad edit fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aliasCategories, detectTools, loadTaxonomy, validateTaxonomy, type Taxonomy } from './taxonomy.ts';

const REAL = new URL('../../../reference-library/business-analyst/categories.json', import.meta.url).pathname;
const small = (): Taxonomy => ({
  role: 'business analyst',
  categories: [
    { id: 'sql-querying', name: 'SQL and data querying', description: 'x', aliases: ['sql', 'database queries'] },
    { id: 'erp-analysis', name: 'Enterprise systems analysis', description: 'x', aliases: ['erp'] },
    { id: 'process-modeling', name: 'Process modeling', description: 'x', aliases: ['process mapping', 'process modeling', 'bpmn'] },
  ],
  tools: [{ name: 'Workday', aliases: ['workday'], category: 'erp-analysis' }, { name: 'Oracle', aliases: ['oracle', 'oracle ebs'], category: 'erp-analysis' }],
});

test('the real business analyst taxonomy has no errors', () => {
  const t = loadTaxonomy(REAL);
  assert.deepEqual(validateTaxonomy(t), []);
  assert.ok(t.categories.length >= 15 && t.tools.length >= 10);
});

test('a taxonomy is refused for duplicate ids, a shared alias, a tool that names a missing category, or a category named after a tool', () => {
  const t = small();
  t.categories.push({ ...t.categories[0]! });
  assert.match(validateTaxonomy(t).join('|'), /duplicate category id "sql-querying"/);
  const shared = small();
  shared.categories[1]!.aliases.push('sql');
  assert.match(validateTaxonomy(shared).join('|'), /alias "sql" is used by both/);
  const missing = small();
  missing.tools[0]!.category = 'nope';
  assert.match(validateTaxonomy(missing).join('|'), /tool "Workday" maps to a category that does not exist: nope/);
  const named = small();
  named.categories[1]!.name = 'Oracle';
  assert.match(validateTaxonomy(named).join('|'), /category "Oracle" is named after a tool/);
  const badId = small();
  badId.categories[0]!.id = 'Not Kebab';
  assert.match(validateTaxonomy(badId).join('|'), /id "Not Kebab" must be lower-case words joined by hyphens/);
});

test('aliases found in a phrase, as whole words, name its categories; a phrase about two skills names both; none is invented', () => {
  const t = small();
  assert.deepEqual(aliasCategories(t, 'Strong SQL skills'), ['sql-querying']);
  assert.deepEqual(aliasCategories(t, 'map current-state processes using BPMN'), ['process-modeling']);
  assert.deepEqual(aliasCategories(t, 'process mapping'), ['process-modeling']);
  assert.deepEqual(aliasCategories(t, 'nosql databases'), [], 'sql inside another word is not a match');
  assert.deepEqual(aliasCategories(t, 'write sql for erp reports'), ['sql-querying', 'erp-analysis']);
  assert.deepEqual(aliasCategories(t, 'stakeholder management'), []);
});

test('tools are found as whole words, in any case, with their display name; none is invented', () => {
  const t = small();
  assert.deepEqual(detectTools(t, 'Configure Oracle EBS financials and Workday reports'), ['Oracle', 'Workday']);
  assert.deepEqual(detectTools(t, 'oraclemind analytics'), []);
  assert.deepEqual(detectTools(t, 'process mapping'), []);
});

test('a one-letter tool or alias (the language R) matches only when it is the whole phrase, never a stray letter inside another one', () => {
  const t = small();
  t.tools.push({ name: 'R', aliases: ['r programming'], category: 'sql-querying' });
  assert.deepEqual(detectTools(t, 'R'), ['R']);
  assert.deepEqual(detectTools(t, ' r '), ['R']);
  assert.deepEqual(detectTools(t, 'R programming'), ['R']);
  for (const phrase of ['accounts receivable (A/R) processing', 'R&D tax credits', 'Plan R rollout']) assert.deepEqual(detectTools(t, phrase), [], phrase);
});

test('terms left unplaced are checked: each must be a plain non-empty phrase and none may also be a category alias', () => {
  const t = small();
  t.unplaced = ['apache spark', 'active directory'];
  assert.deepEqual(validateTaxonomy(t), []);
  t.unplaced = ['sql'];
  assert.match(validateTaxonomy(t).join('|'), /"sql" is both an alias of sql-querying and left unplaced/);
  t.unplaced = ['  ', 7 as never];
  assert.match(validateTaxonomy(t).join('|'), /left-unplaced terms must be non-empty text/);
});
