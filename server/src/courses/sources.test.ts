// Plan 16, phase 2, step 6: the evidence. A posting is one shared row reused by every course that uses it; a pasted description is a
// private row that never counts; mentions are counted from the skills each source asks for (spec 16, section 4).
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, concept, course, role } from '../../testkit/courseFixtures.ts';
import { createSources } from './sources.ts';

const { db } = useCourseDb('sources', { reset: ['sources'] });
const T = new Date('2026-10-20T09:00:00.000Z');
const posting = (over: Record<string, unknown> = {}) => ({ company: 'Acme', roleTitle: 'Senior Product Manager', designation: 'Senior', url: 'https://jobs.acme.example.com/job/1', match: 'exact' as const, foundVia: 'tracked_search' as const, ...over });

db('a researched posting is stored with every field, as shared evidence that counts', async (p) => {
  const r = await role(p);
  const sources = createSources(p, () => T);
  const id = await sources.upsertPosting(r, posting({ postedAt: new Date('2026-10-01T00:00:00.000Z') }));
  const s = (await p.query(`SELECT * FROM sources WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(
    [s.role_id, s.role_title, s.designation, s.company, s.url, s.origin, s.found_via, s.match, s.counts_for_criticality, s.visibility, s.owner_account_id, s.status],
    [r, 'Senior Product Manager', 'Senior', 'Acme', 'https://jobs.acme.example.com/job/1', 'research', 'tracked_search', 'exact', true, 'shared', null, 'proposed'],
  );
  assert.equal(s.posted_at.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(s.last_seen_at.toISOString(), T.toISOString());
});

db('the same posting for the same role is one row, reused and refreshed; the same page for another role is another row', async (p) => {
  const [r1, r2] = [await role(p), await role(p)];
  const sources = createSources(p, () => T);
  const a = await sources.upsertPosting(r1, posting());
  const later = createSources(p, () => new Date('2026-10-27T09:00:00.000Z'));
  const b = await later.upsertPosting(r1, posting({ roleTitle: 'Senior Product Manager (Payments)' }));
  assert.equal(a, b);
  const s = (await p.query(`SELECT role_title, last_seen_at FROM sources WHERE id = $1`, [a])).rows[0];
  assert.equal(s.role_title, 'Senior Product Manager (Payments)');
  assert.equal(s.last_seen_at.toISOString(), '2026-10-27T09:00:00.000Z');
  assert.notEqual(await sources.upsertPosting(r2, posting()), a);
  assert.equal((await p.query(`SELECT count(*) FROM sources WHERE url = $1`, [posting().url])).rows[0].count, '2');
});

db('one source row serves every course that uses it', async (p) => {
  const r = await role(p);
  const sources = createSources(p, () => T);
  const id = await sources.upsertPosting(r, posting());
  const [c1, c2] = [await course(p, r, { status: 'cancelled' }), await course(p, r, { status: 'finding_sources' })];
  await sources.attach(c1, id, 'pool');
  await sources.attach(c2, id, 'pool');
  await sources.attach(c2, id, 'pool'); // attaching again changes nothing
  assert.equal((await p.query(`SELECT count(*) FROM course_sources WHERE source_id = $1`, [id])).rows[0].count, '2');
  assert.equal((await p.query(`SELECT count(*) FROM sources WHERE id = $1`, [id])).rows[0].count, '1');
  await assert.rejects(sources.attach(c1, id, 'not_used'), /reason/); // a source that is not used needs a reason
  const other = await sources.upsertPosting(r, posting({ url: 'https://jobs.acme.example.com/job/2', company: 'Other' }));
  await sources.attach(c1, other, 'not_used', 'title only resembles the role');
  assert.equal((await p.query(`SELECT reason FROM course_sources WHERE course_id = $1 AND source_id = $2`, [c1, other])).rows[0].reason, 'title only resembles the role');
});

db('Scenario: mentions are counted from the skills each current source asks for', async (p) => {
  const r = await role(p);
  const sources = createSources(p, () => T);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await sources.upsertPosting(r, posting({ company: `Co ${i}`, url: `https://jobs.example.com/${r}/${i}` })));
  await p.query(`UPDATE sources SET status = 'current' WHERE id = ANY($1)`, [ids]);
  const [sql, roadmap] = [await concept(p, r, 'sql'), await concept(p, r, 'roadmapping')];
  await sources.setSkills(ids[0]!, [sql, roadmap]);
  await sources.setSkills(ids[1]!, [sql]);
  await sources.setSkills(ids[2]!, [sql]);
  await sources.setSkills(ids[3]!, [sql, sql]); // a skill listed twice is one row
  const counts = async (id: string) => (await p.query(`SELECT mentions, of_postings FROM role_concepts WHERE id = $1`, [id])).rows[0];

  await sources.recountMentions(r);
  assert.deepEqual(await counts(sql), { mentions: 4, of_postings: 5 });
  assert.deepEqual(await counts(roadmap), { mentions: 1, of_postings: 5 });

  await p.query(`UPDATE sources SET status = 'closed' WHERE id = $1`, [ids[0]]); // a closed posting no longer counts
  await sources.recountMentions(r);
  assert.deepEqual(await counts(sql), { mentions: 3, of_postings: 4 });
  assert.deepEqual(await counts(roadmap), { mentions: 0, of_postings: 4 });
});

db('a pasted description is a private source that never counts and is never shared', async (p) => {
  const r = await role(p);
  const owner = await account(p);
  const sources = createSources(p, () => T);
  const id = await sources.registerPaste(r, owner, { roleTitle: 'Product manager' });
  const s = (await p.query(`SELECT origin, url, visibility, owner_account_id, counts_for_criticality, company, found_via FROM sources WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(s, { origin: 'user_paste', url: null, visibility: 'private', owner_account_id: owner, counts_for_criticality: false, company: 'Not named', found_via: 'user' });
  const { rows } = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sources'`);
  assert.ok(!rows.some((c) => /text|body|content|description/.test(c.column_name)), 'no column can hold page text');
});

db('Scenario: a link counts as that employer\'s posting once, and only if its title matches the role', async (p) => {
  const r = await role(p);
  const sources = createSources(p, () => T);
  const counts = async (id: string) => (await p.query(`SELECT counts_for_criticality, origin, found_via, visibility FROM sources WHERE id = $1`, [id])).rows[0];

  const first = await sources.registerLink(r, posting({ company: 'Acme', url: 'https://jobs.acme.example.com/job/10' }));
  assert.deepEqual(await counts(first), { counts_for_criticality: true, origin: 'user_url', found_via: 'user', visibility: 'shared' });
  const second = await sources.registerLink(r, posting({ company: 'Acme', url: 'https://jobs.acme.example.com/job/11' }));
  assert.equal((await counts(second)).counts_for_criticality, false, 'the employer already has its posting');
  const near = await sources.registerLink(r, posting({ company: 'Other', url: 'https://jobs.other.example.com/job/1', match: 'similar' }));
  assert.equal((await counts(near)).counts_for_criticality, false, 'a title that only resembles the role is listed, not counted');
  const alias = await sources.registerLink(r, posting({ company: 'Third', url: 'https://jobs.third.example.com/job/1', match: 'alias' }));
  assert.equal((await counts(alias)).counts_for_criticality, true);

  // A researched posting already counted for the employer means a link from the same employer does not count either.
  const found = await sources.upsertPosting(r, posting({ company: 'Fourth', url: 'https://jobs.fourth.example.com/job/1' }));
  const dup = await sources.registerLink(r, posting({ company: 'Fourth', url: 'https://jobs.fourth.example.com/job/2' }));
  assert.equal((await counts(found)).counts_for_criticality, true);
  assert.equal((await counts(dup)).counts_for_criticality, false);
});

db('an alias is learned only from a confident match, counted each time, and never from the role\'s own name', async (p) => {
  const r = await role(p, 'forward-deployed engineer');
  const sources = createSources(p, () => T);
  await sources.learnAlias(r, 'Frontier Deployed Engineer', true);
  await sources.learnAlias(r, '  frontier deployed engineer ', true);
  await sources.learnAlias(r, 'Solutions Architect', false); // not confident: nothing learned
  await sources.learnAlias(r, 'Forward-Deployed Engineer', true); // the role's own name
  const { rows } = await p.query(`SELECT title_seen, times_seen FROM role_aliases WHERE role_id = $1`, [r]);
  assert.deepEqual(rows, [{ title_seen: 'frontier deployed engineer', times_seen: 2 }]);
});
