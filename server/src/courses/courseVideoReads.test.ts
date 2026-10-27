import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, concept, role } from '../../testkit/courseFixtures.ts';
import { createCourseReads } from './reads.ts';

const { db } = useCourseDb('vreads');
const NOW = new Date('2026-10-20T00:00:00Z');

db('a video card older than 25 days is not shown, because its YouTube data is stale (spec decision 34); articles are unaffected', async (p) => {
  const c = await concept(p, await role(p));
  const add = (kind: string, url: string, checkedAt: string) => p.query(`INSERT INTO resources (concept_id, kind, title, source, url, why, checked_at) VALUES ($1, $2, 't', 's', $3, 'w', $4)`, [c, kind, url, checkedAt]);
  await add('video', 'https://www.youtube.com/watch?v=fresh', '2026-10-10T00:00:00Z'); // 10 days
  await add('video', 'https://www.youtube.com/watch?v=stale', '2026-09-20T00:00:00Z'); // 30 days
  await add('video', 'https://www.youtube.com/watch?v=edge', '2026-09-25T00:00:00Z'); // 25 days exactly
  await add('article', 'https://example.com/old-article', '2026-01-01T00:00:00Z');
  const r = await createCourseReads(p, () => NOW).resources(await account(p), c);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual((r.body.resources as Array<{ url: string }>).map((x) => x.url).sort(), ['https://example.com/old-article', 'https://www.youtube.com/watch?v=fresh']);
});
