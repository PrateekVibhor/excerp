// List-course notifications: the diff job. After the library changes it re-rates a list course's thin and missing concepts against the NEW sources only (the
// shared rating function: a source must teach the concept), and writes a notification for a concept only if its coverage went up. Falls are recorded silently
// and never create a version. Real SQL; fake model and page reader.
import assert from 'node:assert/strict';
import { useCourseDb } from '../../testkit/courseDb.ts';
import { account, publishedListCourse } from '../../testkit/courseFixtures.ts';
import type { Chat } from '../llm.ts';
import { enrolReader } from './enrol.ts';
import { libraryVersion, saveSource, setSourceStatus } from './library/db.ts';
import type { LibrarySource } from './library/load.ts';
import { refreshListCourse, refreshListCourses } from './listRefresh.ts';
import { createCourseReads } from './reads.ts';

const TABLES = ['roles', 'accounts', 'library_sources', 'library_changes', 'library_role_files', 'library_candidates', 'library_gaps'];
const { db } = useCourseDb('listrefresh', { reset: TABLES });
const NOW = new Date('2026-10-25T12:00:00Z');
const SLUG = 'business-analyst';
const filler = (n: number) => 'Unrelated words about something else entirely, said at some length. '.repeat(n);
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Source ${id}`, url: `https://${id}.example.org/doc`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true, applies_to: [SLUG], rationale: 'Trusted.', licence: 'CC BY 4.0', free_parts: 'whole page', last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true }, next_check: '2026-11-16', status: 'active', ...over }) as LibrarySource;
/** Pages: "skill N" is the term of the fixture's Nth concept. Each page names its concepts four times. */
const about = (...n: number[]) => `${filler(5)}${n.map((i) => `Skill ${i} explained. Learn skill ${i}. Practise skill ${i}. More on skill ${i}. `).join('')}${filler(5)}`;
const WEB: Record<string, string> = {};
const read = (log: string[] = []) => async (s: { id: string; url: string }) => (log.push(s.url), WEB[s.url] ? ({ ok: true as const, id: s.id, text: WEB[s.url]!, kind: 'html' as const }) : ({ ok: false as const, id: s.id, reason: 'HTTP 404' }));
type Ask = { source: { name: string }; categories: Array<{ id: string; excerpts: string[] }> };
/** Teaches everything it is shown, except the (source name, concept id) pairs its predicate refuses; 'down' makes the model fail. */
function model(refuse: (source: string, concept: string) => boolean | 'down' = () => false) {
  const calls = { teach: 0, verify: 0 };
  const chat: Chat = async (m) => {
    const system = m[0]!.content;
    const user = m.at(-1)!.content;
    if (/TEACHES a skill or only mentions it/.test(system)) {
      calls.teach++;
      const ask = JSON.parse(user) as Ask;
      if (ask.categories.some((c) => refuse(ask.source.name, c.id) === 'down')) throw new Error('model down');
      return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: refuse(ask.source.name, c.id) ? 'mentions' : 'teaches', evidence: (c.excerpts[0] ?? '').slice(10, 80) })) });
    }
    calls.verify++;
    return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
  };
  return Object.assign(chat, { calls });
}
type P = Parameters<typeof publishedListCourse>[0];

/** A ready BA list course with four concepts (strong, thin, missing, missing), one reader, and a library at version N. */
async function setup(p: P) {
  const c = await publishedListCourse(p, { concepts: 4, roleName: 'business analyst' });
  await p.query(`INSERT INTO library_role_files (role_slug, role) VALUES ($1, $1)`, [SLUG]);
  await saveSource(p, ent('lib-one', { url: 'https://links.example.org/0/0' }), SLUG, 'seed'); // the library source behind the first concept's vetted link
  const reader = await account(p);
  await enrolReader(p, reader, c.courseId, 'business analyst', NOW);
  await p.query(`UPDATE list_concepts SET library_version = $2 WHERE course_id = $1`, [c.courseId, await libraryVersion(p)]); // rated at the current library version
  return { ...c, reader };
}
const deps = (p: P, chat: Chat, log: string[] = []) => ({ pool: p, chat, read: read(log), now: () => NOW });
const bands = async (p: P, courseId: string) => (await p.query(`SELECT l.display_name AS n, l.band FROM list_concepts l JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 ORDER BY l.position`, [courseId])).rows.map((r) => `${r.n}:${r.band}`);
const changes = async (p: P, courseId: string) => (await p.query(`SELECT kind, target, summary, published_at IS NOT NULL AS live FROM course_changes WHERE course_id = $1 ORDER BY target`, [courseId])).rows;
const versions = async (p: P, courseId: string) => (await p.query(`SELECT version, status FROM course_versions WHERE course_id = $1 ORDER BY version`, [courseId])).rows.map((r) => `${r.version}:${r.status}`);
const hasUpdates = async (p: P, reader: string, courseId: string) => {
  const r = await createCourseReads(p, () => NOW).home(reader, courseId);
  return r.kind === 'ok' && r.body.has_updates === true;
};

db('a new source that teaches a missing concept notifies that concept only: a new published version, one change row, the link added, the old version superseded', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3); // the third concept ("Display 2" in the list) is missing
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const r = await refreshListCourse(deps(p, model()), c.courseId);
  assert.equal(r.status, 'done');
  assert.ok(r.status === 'done' && r.rises.length === 1 && r.rises[0]!.from === 'missing' && r.rises[0]!.to === 'thin');
  assert.deepEqual(await versions(p, c.courseId), ['1:superseded', '2:published']);
  const ch = await changes(p, c.courseId);
  assert.equal(ch.length, 1);
  assert.deepEqual([ch[0]!.kind, ch[0]!.target, ch[0]!.live], ['coverage_improved', c.conceptIds[2], true]);
  assert.match(ch[0]!.summary, /Display 2: now thin, with 1 vetted source \(was missing\)/);
  assert.deepEqual(await bands(p, c.courseId), ['Display 0:strong', 'Display 1:thin', 'Display 2:thin', 'Display 3:missing']);
  const link = (await p.query(`SELECT l.library_source_id FROM list_links l JOIN courses c ON c.published_version = l.version_id WHERE c.id = $1 AND l.concept_id = $2`, [c.courseId, c.conceptIds[2]])).rows;
  assert.deepEqual(link.map((x) => x.library_source_id), ['new-a']);
  assert.equal(await hasUpdates(p, c.reader, c.courseId), true, 'the reader sees "what\'s new" through the existing mechanism');
});

db('the new version carries everything the old one had, and no written content is made', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const before = (await p.query(`SELECT count(*)::int AS n FROM list_links WHERE version_id = $1`, [c.versionId])).rows[0].n;
  const counts = async () => Promise.all(['chapter_texts', 'section_quizzes', 'story_bible', 'course_sections'].map(async (t) => (await p.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n));
  const written = await counts();
  await refreshListCourse(deps(p, model()), c.courseId);
  assert.deepEqual(await counts(), written, 'no chapter, quiz, story or section was written');
  const v2 = (await p.query(`SELECT published_version FROM courses WHERE id = $1`, [c.courseId])).rows[0].published_version;
  assert.notEqual(v2, c.versionId);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_concepts WHERE version_id = $1`, [v2])).rows[0].n, 4);
  assert.equal((await p.query(`SELECT count(*)::int AS n FROM list_links WHERE version_id = $1`, [v2])).rows[0].n, before + 1);
});

db('every rise is announced, in one version: a thin concept going strong and a missing one going thin, and the strong concept is not mentioned', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(2, 3, 1); // the second concept is thin with one blog link: a library source makes it strong
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const r = await refreshListCourse(deps(p, model()), c.courseId);
  assert.ok(r.status === 'done' && r.rises.length === 2);
  assert.deepEqual((await changes(p, c.courseId)).map((x) => x.target).sort(), [c.conceptIds[1], c.conceptIds[2]].sort());
  assert.deepEqual(await bands(p, c.courseId), ['Display 0:strong', 'Display 1:strong', 'Display 2:thin', 'Display 3:missing']);
  assert.deepEqual(await versions(p, c.courseId), ['1:superseded', '2:published']);
});

db('a source that only mentions the concept notifies nothing and makes no version; a source that is only proposed (not in the library) is never looked at', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const only = model(() => true);
  const r = await refreshListCourse(deps(p, only), c.courseId);
  assert.ok(r.status === 'done' && r.rises.length === 0);
  assert.deepEqual([await changes(p, c.courseId), await versions(p, c.courseId)], [[], ['1:published']]);
  assert.deepEqual(await bands(p, c.courseId), ['Display 0:strong', 'Display 1:thin', 'Display 2:missing', 'Display 3:missing']);
  // a candidate the finder found but nobody admitted is not a library change
  const pages: string[] = [];
  await p.query(`INSERT INTO library_candidates (role_slug, category_id, url, status, draft) VALUES ($1, 'x', 'https://proposed.example.org/doc', 'proposed', '{}')`, [SLUG]);
  WEB['https://proposed.example.org/doc'] = about(4);
  const again = await refreshListCourse(deps(p, model(), pages), c.courseId);
  assert.equal(again.status, 'skipped');
  assert.deepEqual(pages, []);
});

db('the same library version is never announced twice: running again changes nothing, and a second job racing the first finds the course busy or current', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  assert.equal((await refreshListCourse(deps(p, model()), c.courseId)).status, 'done');
  const again = await refreshListCourse(deps(p, model()), c.courseId);
  assert.deepEqual(again, { status: 'skipped', reason: 'up_to_date' });
  assert.equal((await changes(p, c.courseId)).length, 1);
  assert.deepEqual(await versions(p, c.courseId), ['1:superseded', '2:published']);
  // a version already being built (a rebuild in progress) is left alone
  await p.query(`INSERT INTO course_versions (course_id, version, status) VALUES ($1, 3, 'building')`, [c.courseId]);
  WEB['https://new-b.example.org/doc'] = about(4);
  await saveSource(p, ent('new-b'), SLUG, 'finder');
  assert.deepEqual(await refreshListCourse(deps(p, model()), c.courseId), { status: 'skipped', reason: 'busy' });
});

db('a source taken out of the library is a fall: the stored rating follows it in place, no version is made and no change is written', async (p) => {
  const c = await setup(p);
  await setSourceStatus(p, 'lib-one', 'flagged', 'a reader said it is the wrong field');
  const r = await refreshListCourse(deps(p, model()), c.courseId);
  assert.ok(r.status === 'done' && r.rises.length === 0 && r.falls === 1);
  assert.deepEqual(await bands(p, c.courseId), ['Display 0:thin', 'Display 1:thin', 'Display 2:missing', 'Display 3:missing']);
  assert.deepEqual([await versions(p, c.courseId), await changes(p, c.courseId)], [['1:published'], []]);
  assert.equal((await p.query(`SELECT min(library_version) AS v FROM list_concepts WHERE version_id = $1`, [c.versionId])).rows[0].v, String(await libraryVersion(p)), 'the stamp moved on');
});

db('a fall and a rise in the same run make one version that announces only the rise', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  await setSourceStatus(p, 'lib-one', 'flagged', 'wrong field');
  const r = await refreshListCourse(deps(p, model()), c.courseId);
  assert.ok(r.status === 'done' && r.rises.length === 1 && r.falls === 1);
  assert.deepEqual((await changes(p, c.courseId)).map((x) => x.target), [c.conceptIds[2]]);
  assert.deepEqual(await bands(p, c.courseId), ['Display 0:thin', 'Display 1:thin', 'Display 2:thin', 'Display 3:missing']);
});

db('if the judge or a page is unavailable nothing is guessed: the rise is not announced, the stamp does not move, and the next run announces it once', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const v = await libraryVersion(p);
  const down = await refreshListCourse(deps(p, model(() => 'down')), c.courseId);
  assert.ok(down.status === 'done' && down.rises.length === 0 && down.complete === false);
  assert.deepEqual([await changes(p, c.courseId), await versions(p, c.courseId)], [[], ['1:published']]);
  assert.notEqual((await p.query(`SELECT min(library_version) AS v FROM list_concepts WHERE version_id = $1`, [c.versionId])).rows[0].v, String(v));
  const unreadable = await refreshListCourse({ ...deps(p, model()), read: async (s: { id: string }) => ({ ok: false as const, id: s.id, reason: 'HTTP 503' }) }, c.courseId);
  assert.ok(unreadable.status === 'done' && unreadable.complete === false && unreadable.rises.length === 0);
  const ok = await refreshListCourse(deps(p, model()), c.courseId);
  assert.ok(ok.status === 'done' && ok.rises.length === 1 && ok.complete === true);
  assert.equal((await changes(p, c.courseId)).length, 1);
  assert.deepEqual(await refreshListCourse(deps(p, model()), c.courseId), { status: 'skipped', reason: 'up_to_date' });
});

db('a concept that already links to the source is not announced again, and a source for another role or one that needs an account is ignored', async (p) => {
  const c = await setup(p);
  WEB['https://other-role.example.org/doc'] = about(3);
  WEB['https://gated.example.org/doc'] = about(3);
  await saveSource(p, ent('other-role', { applies_to: ['product-manager'] }), 'product-manager', 'finder');
  await saveSource(p, ent('gated', { access: 'free_account', pipeline_readable: false }), SLUG, 'finder');
  const pages: string[] = [];
  const r = await refreshListCourse(deps(p, model(), pages), c.courseId);
  assert.ok(r.status === 'done' && r.rises.length === 0);
  assert.deepEqual(pages, [], 'neither page was even opened');
  assert.deepEqual(await changes(p, c.courseId), []);
});

db('courses that cannot or should not be told are skipped with a reason: unknown, narrative, withdrawn, with no readers, or not up to date', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  assert.deepEqual(await refreshListCourse(deps(p, model()), '00000000-0000-4000-8000-000000000000'), { status: 'skipped', reason: 'not_a_ready_list_course' });
  await p.query(`UPDATE courses SET mode = 'narrow' WHERE id = $1`, [c.courseId]);
  assert.equal((await refreshListCourse(deps(p, model()), c.courseId)).status, 'skipped');
  await p.query(`UPDATE courses SET mode = 'list', status = 'withdrawn', withdrawn_at = $2, withdrawal_note = 'withdrawn' WHERE id = $1`, [c.courseId, NOW]);
  assert.equal((await refreshListCourse(deps(p, model()), c.courseId)).status, 'skipped');
  await p.query(`UPDATE courses SET status = 'ready', withdrawn_at = NULL, withdrawal_note = NULL WHERE id = $1`, [c.courseId]);
  await p.query(`DELETE FROM course_inputs WHERE course_id = $1`, [c.courseId]);
  assert.deepEqual(await refreshListCourse(deps(p, model()), c.courseId), { status: 'skipped', reason: 'no_readers' });
  assert.deepEqual(await versions(p, c.courseId), ['1:published']);
});

db('a failed search leaves no trace in the library, so there is nothing to announce', async (p) => {
  const c = await setup(p);
  const { runFinder } = await import('./gaps/finder.ts');
  const { createBudget } = await import('./gaps/budget.ts');
  await p.query(`INSERT INTO library_gaps (role_slug, category_id, first_seen_version) VALUES ($1, 'x', 1)`, [SLUG]);
  const before = await libraryVersion(p);
  await runFinder({ pool: p, chat: model(), search: { search: async () => { throw new Error('search down'); } }, read: read(), budget: createBudget({ perGap: 4, batch: 20, ledger: { charge() {} } }) }, SLUG, ['x']).catch(() => undefined);
  assert.equal(await libraryVersion(p), before);
  assert.deepEqual(await refreshListCourse(deps(p, model()), c.courseId), { status: 'skipped', reason: 'up_to_date' });
});

db('the words of a notification say what is true now and never promise anything: no dates, no "soon", no "will"', async (p) => {
  const c = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(2, 3, 4);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  await refreshListCourse(deps(p, model()), c.courseId);
  const all = await changes(p, c.courseId);
  assert.equal(all.length, 3);
  for (const x of all) assert.doesNotMatch(x.summary, /\bwill\b|\bsoon\b|\bcoming\b|\bexpect|\d{4}-\d{2}|\bnext (week|month|check)/i, x.summary);
  // a concept that is still missing gets no change row at all
  assert.equal(all.some((x) => x.target === c.conceptIds[2] && /missing$/.test(x.summary)), false);
});

db('the database refuses to announce the same concept twice in one version', async (p) => {
  const c = await setup(p);
  await p.query(`INSERT INTO course_changes (course_id, version_id, kind, target, summary) VALUES ($1,$2,'coverage_improved','k1','x')`, [c.courseId, c.versionId]);
  await assert.rejects(p.query(`INSERT INTO course_changes (course_id, version_id, kind, target, summary) VALUES ($1,$2,'coverage_improved','k1','y')`, [c.courseId, c.versionId]), /course_changes_coverage_key/);
});

db('refreshing all the courses of a role goes through each ready list course, and one course failing does not stop the others', async (p) => {
  const a = await setup(p);
  WEB['https://new-a.example.org/doc'] = about(3);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  const r = await refreshListCourses(deps(p, model()), SLUG);
  assert.deepEqual([r.courses, r.notified, r.errors], [1, 1, 0]);
  assert.equal((await changes(p, a.courseId)).length, 1);
  assert.deepEqual(await refreshListCourses(deps(p, model()), SLUG), { courses: 1, notified: 0, errors: 0 });
});

db('every check stamps when the list was last checked, including one that found the library unchanged; a check that could not run does not', async (p) => {
  const c = await setup(p);
  const checked = async () => (await p.query(`SELECT last_checked_at FROM courses WHERE id = $1`, [c.courseId])).rows[0].last_checked_at as Date | null;
  assert.equal(await checked(), null);
  assert.equal((await refreshListCourse(deps(p, model()), c.courseId)).status, 'skipped'); // up to date
  assert.equal((await checked())?.toISOString(), NOW.toISOString(), 'a check that found nothing new is still a check');
  await p.query(`UPDATE courses SET last_checked_at = NULL WHERE id = $1`, [c.courseId]);
  await saveSource(p, ent('new-a'), SLUG, 'finder');
  WEB['https://new-a.example.org/doc'] = about(3);
  assert.equal((await refreshListCourse(deps(p, model()), c.courseId)).status, 'done');
  assert.equal((await checked())?.toISOString(), NOW.toISOString());
  await p.query(`UPDATE courses SET last_checked_at = NULL WHERE id = $1`, [c.courseId]);
  await p.query(`DELETE FROM course_inputs WHERE course_id = $1`, [c.courseId]);
  assert.deepEqual(await refreshListCourse(deps(p, model()), c.courseId), { status: 'skipped', reason: 'no_readers' });
  assert.equal(await checked(), null, 'nobody reads it, so it was not looked at');
});
