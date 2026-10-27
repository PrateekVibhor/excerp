// Plan 16, part 3, step B: the dry-run coverage report, as a document the owner reads. Pure: numbers in, markdown out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageFor } from './match.ts';
import { renderReport } from './report.ts';

const concepts = [
  { name: 'roadmap planning', kind: 'skill' as const, terms: ['roadmap planning'], mentions: 8 },
  { name: 'kubernetes', kind: 'skill' as const, terms: ['kubernetes'], mentions: 2 },
];
const texts = [{ id: 'src-a', text: 'Roadmap planning links goals to work.' }, { id: 'src-b', text: 'Roadmap planning again.' }];

test('the report gives, for each course, the counts, the weighted share, the concepts the library does not mention, and the sources that mention nothing', () => {
  const md = renderReport({
    date: '2026-10-17',
    library: { errors: 0, warnings: 3 },
    courses: [
      { role: 'business analyst', courseId: 'c1', status: 'ready', slug: 'business-analyst', concepts, sourcesRead: 2, sourcesSkipped: [{ id: 'acct', reason: 'not readable by the pipeline (needs a free account)' }], coverage: coverageFor(concepts, texts) },
      { role: 'backend software engineer', courseId: 'c2', status: 'ready', slug: null, concepts, sourcesRead: 0, sourcesSkipped: [], coverage: null },
    ],
  });
  assert.match(md, /^# Reference library: dry-run coverage/m);
  assert.match(md, /business analyst[\s\S]*1 of 2 concepts mentioned/);
  assert.match(md, /80% of the postings' mentions/); // 8 of 10
  assert.match(md, /kubernetes/); // not mentioned by any source
  assert.match(md, /backend software engineer[\s\S]*no library folder/i);
  assert.match(md, /acct[^\n]*free account/);
  assert.match(md, /mentioned is not usable/i); // the limit of the measure is stated
  assert.match(md, /0 errors, 3 warnings/);
});
