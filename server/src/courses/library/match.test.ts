// Plan 16, part 3, step B: does the library mention a concept at all? A deterministic, model-free first measure (no spend), so the dry run can say
// roughly how much of a course the library could ground before anything is wired into the pipeline. Mentioned is not the same as usable; the
// report says so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageFor, scenarioHit, termHits, type ConceptIn } from './match.ts';

const skill = (name: string, mentions = 5, terms: string[] = []): ConceptIn => ({ name, kind: 'skill', terms: [name, ...terms], mentions });

test('a term is counted as whole words, in any case, with a plural or a hyphen or space variation, and not inside another word', () => {
  const text = 'Stakeholder analysis helps. Stakeholder Analysis again. A stakeholder-analysis grid. MySQL is not SQL. We use SQL, and sql again.';
  assert.equal(termHits(text, 'stakeholder analysis'), 3);
  assert.equal(termHits(text, 'sql'), 3); // SQL, SQL and sql; the MySQL in the text is another word
  assert.equal(termHits('user stories and a user story map', 'user story'), 2);
  assert.equal(termHits('nothing relevant', 'roadmap'), 0);
  assert.equal(termHits('abc', ''), 0);
});

test('a scenario is found when most of its key words sit close together, not when they are spread over the whole document', () => {
  const near = 'When a release slips, the team runs a retrospective and agrees what to change in the process before the next release.';
  const far = 'A release plan. ' + 'filler words about nothing in particular. '.repeat(60) + 'The retrospective was held. ' + 'more filler text goes here. '.repeat(60) + 'Change the process.';
  assert.equal(scenarioHit(near, 'run a retrospective after a release slips'), true);
  assert.equal(scenarioHit(far, 'run a retrospective after a release slips'), false);
  assert.equal(scenarioHit(near, 'negotiate a vendor contract'), false);
});

test('coverage bands: found in two or more sources is strong, in one is single, in none is none; other names for a concept count', () => {
  const texts = [
    { id: 'a', text: 'Roadmap planning links goals to work. Stakeholder management matters.' },
    { id: 'b', text: 'Roadmap planning is reviewed often. Sprint cadence.' },
    { id: 'c', text: 'Nothing here.' },
  ];
  const concepts = [skill('roadmap planning', 8), skill('stakeholder management', 6), skill('kubernetes', 2), skill('cadence work', 3, ['sprint cadence'])];
  const r = coverageFor(concepts, texts);
  const band = Object.fromEntries(r.rows.map((x) => [x.concept.name, x.band]));
  assert.deepEqual(band, { 'roadmap planning': 'strong', 'stakeholder management': 'single', kubernetes: 'none', 'cadence work': 'single' });
  assert.deepEqual(r.rows.find((x) => x.concept.name === 'roadmap planning')!.sources.map((s) => s.id).sort(), ['a', 'b']);
});

test('the summary counts concepts and weights them by how many postings ask for them', () => {
  const texts = [{ id: 'a', text: 'Roadmap planning. Stakeholder management.' }, { id: 'b', text: 'Roadmap planning.' }];
  const r = coverageFor([skill('roadmap planning', 6), skill('stakeholder management', 3), skill('kubernetes', 1)], texts);
  assert.deepEqual([r.summary.total, r.summary.strong, r.summary.single, r.summary.none], [3, 1, 1, 1]);
  assert.equal(r.summary.weightedMentioned, (6 + 3) / (6 + 3 + 1));
  assert.equal(r.summary.mentioned, 2 / 3);
});

test('per source: how many concepts each one mentions, and which mention none', () => {
  const texts = [{ id: 'a', text: 'Roadmap planning. Stakeholder management.' }, { id: 'b', text: 'Roadmap planning.' }, { id: 'c', text: 'unrelated' }];
  const r = coverageFor([skill('roadmap planning'), skill('stakeholder management')], texts);
  assert.deepEqual(r.perSource.map((s) => [s.id, s.concepts]), [['a', 2], ['b', 1], ['c', 0]]);
  assert.deepEqual(r.summary.sourcesWithNone, ['c']);
});

test('no sources and no concepts are fine', () => {
  const r = coverageFor([], []);
  assert.deepEqual([r.summary.total, r.summary.mentioned, r.summary.weightedMentioned], [0, 0, 0]);
  assert.equal(coverageFor([skill('x')], []).rows[0]!.band, 'none');
});
