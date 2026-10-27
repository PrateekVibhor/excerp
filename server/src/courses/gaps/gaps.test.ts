// Gap queue: a category the library covers thinly or not at all is a gap; it is "filled" only when the latest coverage rating says strong.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../../testkit/courseDb.ts';
import { reconcileGaps, gapsOf } from './gaps.ts';

const { db } = useCourseDb('gaps', { reset: ['library_gaps', 'library_candidates', 'category_coverage', 'library_changes'] });
const SLUG = 'demo-role';
const rate = (p: Parameters<typeof reconcileGaps>[0], version: number, bands: Record<string, string>) =>
  Promise.all(Object.entries(bands).map(([c, band]) => p.query(`INSERT INTO category_coverage (role_slug, category_id, library_version, band, min_hits) VALUES ($1,$2,$3,$4,3)`, [SLUG, c, version, band])));

db('thin and missing categories become open gaps, strong ones are not gaps, and the version they were first seen at is kept', async (p) => {
  await rate(p, 5, { a: 'missing', b: 'thin', c: 'strong' });
  const r = await reconcileGaps(p, SLUG);
  assert.deepEqual([r.opened, r.filled, r.reopened], [2, 0, 0]);
  const gaps = await gapsOf(p, SLUG);
  assert.deepEqual(gaps.map((g) => [g.category_id, g.status, g.first_seen_version]), [['a', 'open', 5], ['b', 'open', 5]]);
});

db('reconciling again changes nothing; a gap that the newest rating calls strong is filled, with the version that filled it', async (p) => {
  await rate(p, 5, { a: 'missing', b: 'thin' });
  await reconcileGaps(p, SLUG);
  assert.deepEqual(await reconcileGaps(p, SLUG), { opened: 0, filled: 0, reopened: 0 });
  await rate(p, 7, { a: 'strong', b: 'thin' });
  const r = await reconcileGaps(p, SLUG);
  assert.deepEqual([r.opened, r.filled], [0, 1]);
  const g = Object.fromEntries((await gapsOf(p, SLUG)).map((x) => [x.category_id, x]));
  assert.deepEqual([g.a!.status, g.a!.filled_version, g.b!.status, g.b!.first_seen_version], ['filled', 7, 'open', 5]);
});

db('a filled gap that the newest rating drops below strong is open again; only the newest rating is read', async (p) => {
  await rate(p, 5, { a: 'missing' });
  await reconcileGaps(p, SLUG);
  await rate(p, 6, { a: 'strong' });
  await reconcileGaps(p, SLUG);
  await rate(p, 9, { a: 'thin' }); // a source was flagged
  const r = await reconcileGaps(p, SLUG);
  assert.deepEqual([r.reopened, r.filled], [1, 0]);
  const g = (await gapsOf(p, SLUG))[0]!;
  assert.deepEqual([g.status, g.filled_version], ['open', null]);
});

db('a gap with proposed pages waiting stays ready; once none is waiting it is open again', async (p) => {
  await rate(p, 5, { a: 'missing' });
  await reconcileGaps(p, SLUG);
  await p.query(`UPDATE library_gaps SET status = 'candidates_ready' WHERE category_id = 'a'`);
  await p.query(`INSERT INTO library_candidates (role_slug, category_id, url, status) VALUES ($1, 'a', 'https://x.example.org/', 'proposed')`, [SLUG]);
  await rate(p, 6, { a: 'missing' });
  await reconcileGaps(p, SLUG);
  assert.equal((await gapsOf(p, SLUG))[0]!.status, 'candidates_ready');
  await p.query(`UPDATE library_candidates SET status = 'admitted'`); // nothing left waiting: the gap is simply open until the rating says otherwise
  await reconcileGaps(p, SLUG);
  assert.equal((await gapsOf(p, SLUG))[0]!.status, 'open');
});

db('demand: asking for the same gap again raises its demand, which orders the work', async (p) => {
  await rate(p, 5, { a: 'missing', b: 'missing' });
  await reconcileGaps(p, SLUG);
  const { addDemand } = await import('./gaps.ts');
  await addDemand(p, SLUG, ['b', 'b', 'a']);
  const g = Object.fromEntries((await gapsOf(p, SLUG)).map((x) => [x.category_id, x.demand]));
  assert.deepEqual(g, { a: 2, b: 3 });
  assert.deepEqual((await gapsOf(p, SLUG)).map((x) => x.category_id), ['b', 'a'], 'most wanted first');
});
