// Plan 16, part 3, step B: the reference library loader and its check against the schema. A bad library fails here, not in a build. Nothing
// reads the library in the pipeline yet; this is the first reader, and it reads files only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLibrary, sourcesFor, validateLibrary, type LibrarySource } from './load.ts';

const REAL = new URL('../../../reference-library', import.meta.url).pathname;
const TODAY = new Date('2026-10-17T12:00:00Z');

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Source ${id}`, url: `https://example.org/${id}`, layer: 'practical', tier: 2, access: 'open', perspective: 'field', pipeline_readable: true,
  applies_to: ['demo-role'], rationale: 'Why it is trusted.', licence: 'CC BY 4.0 stated on the page', free_parts: 'whole page',
  last_verified: { date: '2026-10-16', how: 'fetched without credentials; page text read', http_status: 200, content_type: 'text/html', bytes: 1000, text_verified: true },
  next_check: '2026-11-16', status: 'active', ...over,
});

/** A small library in a temp folder: shared.json and one role folder. */
function make(shared: unknown[], own: unknown[], usesShared: string[], excluded: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'library-'));
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ note: 'n', sources: shared }));
  mkdirSync(join(dir, 'demo-role'));
  writeFileSync(join(dir, 'demo-role', 'sources.json'), JSON.stringify({ role: 'demo-role', built: '2026-10-16', rules: 'see ../README.md', sources: own, uses_shared: usesShared, checked_and_excluded: excluded }));
  return dir;
}
const check = (dir: string) => {
  try {
    return validateLibrary(loadLibrary(dir), { today: TODAY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const errorsOf = (r: ReturnType<typeof check>) => r.errors.map((e) => e.message);

test('a well-formed library has no errors and no warnings', () => {
  const r = check(make([entry('shared-one', { applies_to: ['demo-role', 'other-role'] })], [entry('own-one')], ['shared-one'], [{ name: 'Gated thing', url: null, result: 'paid', date: '2026-10-16', reason: 'excluded by the access rule' }]));
  assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test('the real library loads, has the three roles built so far, and has no errors', () => {
  const lib = loadLibrary(REAL);
  assert.deepEqual(Object.keys(lib.roles).sort(), ['business-analyst', 'forward-deployed-engineer', 'product-manager']);
  const { errors } = validateLibrary(lib, { today: TODAY });
  assert.deepEqual(errors, []);
  assert.ok(sourcesFor(lib, 'business-analyst').length >= 30 && sourcesFor(lib, 'product-manager').length >= 35 && sourcesFor(lib, 'forward-deployed-engineer').length >= 25);
});

test('a file that is not JSON, or a missing shared.json, stops the load and names the file', () => {
  const dir = make([], [], []);
  writeFileSync(join(dir, 'demo-role', 'sources.json'), '{ not json');
  assert.throws(() => loadLibrary(dir), /demo-role\/sources\.json/);
  assert.throws(() => loadLibrary(join(dir, 'nowhere')), /shared\.json/);
  rmSync(dir, { recursive: true, force: true });
});

test('required fields, enum values, ids, urls and dates are checked, and each problem names the entry', () => {
  const r = check(make([], [
    entry('missing-rationale', { rationale: undefined }),
    entry('bad-layer', { layer: 'theory' }),
    entry('bad-tier', { tier: 4 }),
    entry('bad-access', { access: 'paid' }),
    entry('bad-perspective', { perspective: 'both' }),
    entry('bad-status', { status: 'maybe' }),
    entry('Bad Id!'),
    entry('http-only', { url: 'ftp://example.org/x' }),
    entry('bad-date', { next_check: 'soon' }),
    entry('bad-verified', { last_verified: { date: '2026-13-40', how: 'x', http_status: 200, text_verified: true } }),
  ], []));
  const text = r.errors.map((e) => `${e.where}: ${e.message}`).join('\n');
  for (const want of [
    'missing-rationale: missing rationale', 'bad-layer: layer', 'bad-tier: tier', 'bad-access: access', 'bad-perspective: perspective', 'bad-status: status',
    'Bad Id!: id', 'http-only: url', 'bad-date: next_check', 'bad-verified: last_verified.date',
  ]) assert.ok(text.includes(want), `${want}\n${text}`);
});

test('an id may be used once across the shared file and every role folder', () => {
  const r = check(make([entry('same')], [entry('same')], []));
  assert.ok(errorsOf(r).some((m) => /duplicate id "same"/.test(m)), errorsOf(r).join('; '));
});

test('pipeline_readable must agree with the access class: only an open source can be read by the pipeline', () => {
  const r = check(make([], [entry('open-not-readable', { pipeline_readable: false }), entry('account-readable', { access: 'free_account', pipeline_readable: true })], []));
  assert.ok(errorsOf(r).some((m) => /open source must be pipeline_readable/.test(m)));
  assert.ok(errorsOf(r).some((m) => /free_account source must not be pipeline_readable/.test(m)));
});

test('a role must refer to shared sources that exist and that list the role', () => {
  const r = check(make([entry('shared-other', { applies_to: ['other-role'] })], [], ['shared-other', 'not-there']));
  const m = errorsOf(r);
  assert.ok(m.some((x) => /uses_shared "not-there" is not in shared\.json/.test(x)), m.join('; '));
  assert.ok(m.some((x) => /"shared-other" does not list demo-role in applies_to/.test(x)), m.join('; '));
});

test('a role\'s own source must list that role, and an excluded item must say why', () => {
  const r = check(make([], [entry('wrong-role', { applies_to: ['other-role'] })], [], [{ name: 'No reason', url: null, result: 'x', date: '2026-10-16' }]));
  const m = errorsOf(r);
  assert.ok(m.some((x) => /does not list demo-role in applies_to/.test(x)), m.join('; '));
  assert.ok(m.some((x) => /checked_and_excluded "No reason" has no reason/.test(x)), m.join('; '));
});

test('attributed citation needs its decision_note; a source with no stated reuse terms and no policy is a warning, not an error', () => {
  const r = check(make([], [
    entry('policy-no-note', { citation_policy: 'attributed_citation_only' }),
    entry('policy-ok', { citation_policy: 'attributed_citation_only', decision_note: 'Owner decision, 2026-10-16.', licence: 'no reuse terms stated' }),
    entry('old-style', { licence: 'all rights reserved by the publisher (not verified on the page); free to read, quote briefly with attribution' }),
    entry('explicit-grant', { licence: 'CC BY 4.0 stated in the document' }),
  ], []));
  assert.ok(errorsOf(r).some((m) => /citation_policy needs a decision_note/.test(m)));
  assert.deepEqual(r.warnings.filter((w) => /no stated reuse terms/.test(w.message)).map((w) => w.where), ['old-style']);
});

test('warnings for what needs a look: text not read, access not confirmed, an overdue check, a verification older than 60 days, a source that is not active', () => {
  const r = check(make([], [
    entry('unread', { last_verified: { date: '2026-10-16', how: 'x', http_status: 200, content_type: 'application/pdf', bytes: 5, text_verified: false } }),
    entry('unconfirmed', { access: 'free_account', pipeline_readable: false, access_confirmed: false }),
    entry('overdue', { next_check: '2026-10-01' }),
    entry('stale', { last_verified: { date: '2026-07-01', how: 'x', http_status: 200, content_type: 'text/html', bytes: 5, text_verified: true } }),
    entry('held', { status: 'candidate_other_roles' }),
  ], []));
  const by = (re: RegExp) => r.warnings.filter((w) => re.test(w.message)).map((w) => w.where);
  assert.deepEqual(by(/text was not read/), ['unread']);
  assert.deepEqual(by(/access class not confirmed/), ['unconfirmed']);
  assert.deepEqual(by(/next check is overdue/), ['overdue']);
  assert.deepEqual(by(/last verified more than 60 days ago/), ['stale']);
  assert.deepEqual(by(/not active/), ['held']);
  assert.deepEqual(r.errors, []);
});

test('sourcesFor gives a role its own and its shared active sources, says which can be read by the pipeline, and leaves out the rest', () => {
  const dir = make(
    [entry('shared-ok', { applies_to: ['demo-role'] }), entry('shared-held', { applies_to: ['demo-role'], status: 'candidate_other_roles' })],
    [entry('own-open'), entry('own-account', { access: 'free_account', pipeline_readable: false }), entry('own-suspended', { status: 'suspended' })],
    ['shared-ok', 'shared-held'],
  );
  const got = sourcesFor(loadLibrary(dir), 'demo-role');
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(got.map((s) => [s.id, s.own, s.pipeline_readable]).sort(), [['own-account', true, false], ['own-open', true, true], ['shared-ok', false, true]]);
  assert.deepEqual(sourcesFor({ shared: [], roles: {} }, 'nobody'), []);
});

/** What the source finder writes for every source it admits (src/courses/gaps/finder.ts): the licence line, how it was checked, and the decision note. */
const FINDER_LICENCE = 'No reuse terms checked; the page is linked and never reproduced';
const FINDER_NOTE = /^Vetted automatically by the source finder on (\d{4}-\d{2}-\d{2}): opens without an account, written for the role, and teaches "/;
/** A link-only source is only ever one the finder vetted: its own wording, its own two-run check, and a licence that says the page is linked and never reproduced. */
function finderLinkOnlyProblems(s: LibrarySource & Record<string, any>): string[] {
  const out: string[] = [];
  if (s.licence !== FINDER_LICENCE) out.push('the licence must say the page is linked and never reproduced');
  const note = FINDER_NOTE.exec(String(s.decision_note));
  if (!note) out.push('the decision note must use the finder wording');
  else if (note[1] !== s.last_verified?.date) out.push('the note date must be the date it was verified');
  if (!/^opened by the source finder without credentials/.test(String(s.last_verified?.how))) out.push('it must record that the finder opened it');
  if (s.last_verified?.text_verified !== true || s.last_verified?.access_confirmed !== true) out.push('its text must have been read and its access confirmed');
  if (s.free_parts !== 'whole page (linked)') out.push('it must be recorded as a linked page');
  return out;
}

test('every source in the real library either states its reuse terms or records the attributed-citation decision, the same way; a link-only source is one the finder vetted', () => {
  const lib = loadLibrary(REAL);
  const { warnings } = validateLibrary(lib, { today: TODAY });
  assert.deepEqual(warnings.filter((w) => /no stated reuse terms/.test(w.message)).map((w) => w.where), []);
  const all = [...lib.shared, ...Object.values(lib.roles).flatMap((r) => r.sources)];
  const cited = all.filter((s) => s.citation_policy);
  const attributed = cited.filter((s) => s.citation_policy === 'attributed_citation_only');
  const linkOnly = cited.filter((s) => s.citation_policy === 'link-only');
  assert.equal(attributed.length + linkOnly.length, cited.length, `no other citation policy: ${cited.filter((s) => !['attributed_citation_only', 'link-only'].includes(String(s.citation_policy))).map((s) => s.id)}`);
  assert.ok(attributed.length >= 30, 'the sources with no explicit grant carry the policy');
  for (const s of attributed) {
    assert.equal(s.citation_policy, 'attributed_citation_only', s.id);
    assert.match(String(s.decision_note), /^Attributed citation only: short quotes with clear attribution, pointing the learner to the real page; never full-text reproduction/, s.id);
  }
  assert.ok(linkOnly.length >= 5, 'the five sources the finder added to the business analyst library');
  for (const s of linkOnly) assert.deepEqual(finderLinkOnlyProblems(s), [], s.id);
});

test('a link-only source that the finder did not vet is not accepted: a hand-added one is caught', () => {
  const finder = {
    licence: FINDER_LICENCE, free_parts: 'whole page (linked)', citation_policy: 'link-only',
    decision_note: 'Vetted automatically by the source finder on 2026-10-18: opens without an account, written for the role, and teaches "X" (evidence: "y").',
    last_verified: { date: '2026-10-18', how: 'opened by the source finder without credentials on two independent runs; page text read', http_status: 200, content_type: 'text/html', bytes: 1, text_verified: true, access_confirmed: true },
  } as unknown as LibrarySource;
  assert.deepEqual(finderLinkOnlyProblems(finder), []);
  const byHand = { ...finder, decision_note: 'Added by hand because it looked useful.', licence: 'CC BY 4.0', last_verified: { ...finder.last_verified, how: 'checked by hand', access_confirmed: false } } as unknown as LibrarySource;
  assert.equal(finderLinkOnlyProblems(byHand).length, 4);
  assert.match(finderLinkOnlyProblems({ ...finder, licence: 'all rights reserved' } as LibrarySource).join(), /linked and never reproduced/);
  assert.match(finderLinkOnlyProblems({ ...finder, decision_note: finder.decision_note!.replace('2026-10-18:', '2026-09-01:') } as LibrarySource).join(), /date/);
});

