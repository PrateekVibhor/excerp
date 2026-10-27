import { bandNote, evidenceNote, buildSteps, meterParts, newest, oldestDate, resourceRow, sinceLabel, whatsNew } from './listView';

describe('the coverage meter', () => {
  it('splits the bar in proportion to strong, thin and missing, and leaves out a part that is empty', () => {
    expect(meterParts({ total: 14, strong: 8, thin: 4, missing: 2 })).toEqual([['strong', 8], ['thin', 4], ['missing', 2]]);
    expect(meterParts({ total: 3, strong: 3, thin: 0, missing: 0 })).toEqual([['strong', 3]]);
    expect(meterParts({ total: 0, strong: 0, thin: 0, missing: 0 })).toEqual([]);
  });
});

describe('what is new', () => {
  const change = (id: string, version: number, summary: string, kind = 'coverage_improved') => ({ id, version, kind, target: 'k', summary, publishedAt: '2026-10-13T09:00:00.000Z' });
  it('reads the name and the before and after bands out of the change, or says nothing if it cannot', () => {
    expect(whatsNew([change('a', 3, 'FHIR data formats: now thin, with 1 vetted source (was missing)')])).toEqual([{ id: 'a', name: 'FHIR data formats', from: 'missing', to: 'thin', sources: 1 }]);
    expect(whatsNew([change('b', 3, 'SQL: now strong, with 2 vetted sources (was thin)')])[0]).toMatchObject({ name: 'SQL', from: 'thin', to: 'strong', sources: 2 });
    expect(whatsNew([change('c', 3, 'something else')])).toEqual([]);
    expect(whatsNew([change('d', 3, 'SQL: now strong, with 2 vetted sources (was thin)', 'chapter_added')])).toEqual([]);
  });
  it('only a rise is shown', () => {
    expect(whatsNew([change('e', 3, 'SQL: now thin, with 1 vetted source (was strong)')])).toEqual([]);
  });
  it('the day word is the weekday of the newest change, and the version to mark as seen is the highest', () => {
    expect(sinceLabel('2026-10-13T12:00:00.000Z')).toBe("WHAT'S NEW SINCE TUESDAY");
    expect(newest([change('a', 2, 'x'), change('b', 5, 'y'), change('c', 4, 'z')])).toBe(5);
    expect(newest([])).toBe(0);
  });
});

describe('a resource row', () => {
  it('a library source says Library and its host; a web link says web; a new one says new', () => {
    expect(resourceRow({ title: 'Mode', source: 'mode.com', url: 'https://mode.com/x', vetted: true })).toEqual({ title: 'Mode', label: 'Library · mode.com', vetted: true });
    expect(resourceRow({ title: 'Practice', source: 'example.org', url: 'https://example.org/p', vetted: false })).toEqual({ title: 'Practice', label: 'web', vetted: false });
    expect(resourceRow({ title: 'Mode', source: '', url: 'https://www.hl7.org/fhir', vetted: true }).label).toBe('Library · hl7.org');
  });
});

describe('the building steps', () => {
  it('shows each step done, active or waiting from the stage the server reports', () => {
    const states = (stage: string) => buildSteps(stage).map((s) => s.state);
    expect(states('')).toEqual(['active', 'waiting', 'waiting', 'waiting']);
    expect(states('read')).toEqual(['active', 'waiting', 'waiting', 'waiting']);
    expect(states('rank')).toEqual(['done', 'active', 'waiting', 'waiting']);
    expect(states('reference')).toEqual(['done', 'done', 'active', 'waiting']);
    expect(states('sequence')).toEqual(['done', 'done', 'active', 'waiting']);
    expect(states('list')).toEqual(['done', 'done', 'done', 'active']);
    expect(states('publish')).toEqual(['done', 'done', 'done', 'active']);
  });
  it('names the four steps as designed', () => {
    expect(buildSteps('').map((s) => s.label)).toEqual(['Reading the job posting', 'Listing concepts in order', 'Matching library sources', 'Rating coverage']);
  });
});

describe('the note under a concept', () => {
  const lib = { title: 'a', source: '', url: 'https://a.test', vetted: true };
  const web = { title: 'b', source: '', url: 'https://b.test', vetted: false };
  it('thin with one library source says so; thin with only web links says they are not reviewed; missing says it will be announced', () => {
    expect(bandNote('thin', [lib, web])).toBe('Thin means one library source so far. Web links are found automatically and not reviewed.');
    expect(bandNote('thin', [web])).toBe('Only web links so far. They are found automatically and not reviewed.');
    expect(bandNote('missing', [web])).toBe("No library source yet. We'll let you know on this screen when one is added.");
    expect(bandNote('strong', [lib, web])).toBeNull();
  });
  it('the day word comes from the oldest change the reader has not seen', () => {
    const ch = (d: string) => ({ id: d, version: 1, kind: 'coverage_improved', target: null, summary: '', publishedAt: d });
    expect(oldestDate([ch('2026-10-15T09:00:00.000Z'), ch('2026-10-13T09:00:00.000Z')])).toBe('2026-10-13T09:00:00.000Z');
  });
});

describe('evidenceNote', () => {
  it('says what a thin list was built from', () => {
    expect(evidenceNote({ thin: true, similarPostings: 0, ownPosting: true })).toBe('Built from your posting');
    expect(evidenceNote({ thin: true, similarPostings: 1, ownPosting: true })).toBe('Built from your posting and 1 similar posting');
    expect(evidenceNote({ thin: true, similarPostings: 3, ownPosting: true })).toBe('Built from your posting and 3 similar postings');
    expect(evidenceNote({ thin: true, similarPostings: 3, ownPosting: false })).toBe('Built from 3 similar postings');
  });
  it('says nothing when the evidence is not thin or unknown', () => {
    expect(evidenceNote({ thin: false, similarPostings: 9, ownPosting: false })).toBeNull();
    expect(evidenceNote(null)).toBeNull();
    expect(evidenceNote({ thin: true, similarPostings: 0, ownPosting: false })).toBeNull();
  });
});
