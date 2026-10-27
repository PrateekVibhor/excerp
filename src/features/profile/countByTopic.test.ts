import { INTERESTS, OTHER_TOPIC, type VerifiedRecord } from '../../data/types';
import { countByTopic } from './countByTopic';

let n = 0;
/** A record for a new article with the given topic. */
const record = (topic: unknown): VerifiedRecord => ({ article_id: `article-${++n}`, verified_at: '2026-10-06T10:00:00.000Z', topic: topic as string });
const many = (topic: string, count: number) => Array.from({ length: count }, () => record(topic));
const rows = (records: VerifiedRecord[]) => countByTopic(records).byTopic.map((r) => [r.topic, r.count]);

describe('countByTopic', () => {
  it('Scenario: Counting - Cloud, Cloud, Generative AI gives a total of 3 and the rows Cloud 2, Generative AI 1', () => {
    const stats = countByTopic([record('Cloud'), record('Cloud'), record('Generative AI')]);
    expect(stats.total).toBe(3);
    expect(stats.byTopic).toEqual([{ topic: 'Cloud', count: 2 }, { topic: 'Generative AI', count: 1 }]);
  });

  it('Scenario: Total and breakdown - 5 in Generative AI and 3 in Cloud is a total of 8', () => {
    const stats = countByTopic([...many('Generative AI', 5), ...many('Cloud', 3)]);
    expect(stats.total).toBe(8);
    expect(stats.byTopic).toEqual([{ topic: 'Generative AI', count: 5 }, { topic: 'Cloud', count: 3 }]);
  });

  it('Scenario: Sorting - counts 3, 5 and 5 put the two 5s first, alphabetically, then the 3', () => {
    expect(rows([...many('Safety', 3), ...many('Research', 5), ...many('Agents', 5)])).toEqual([['Agents', 5], ['Research', 5], ['Safety', 3]]);
  });

  it('Scenario: Tie order - Cloud 2 and Chips and hardware 2 puts Chips and hardware first', () => {
    expect(rows([...many('Cloud', 2), ...many('Chips and hardware', 2)])).toEqual([['Chips and hardware', 2], ['Cloud', 2]]);
  });

  it('a tie is ordered by name whatever order the records came in', () => {
    const records = [...many('Safety', 2), ...many('Open source', 2), ...many('Agents', 2), ...many('Developer tools', 2)];
    const expected = [['Agents', 2], ['Developer tools', 2], ['Open source', 2], ['Safety', 2]];
    expect(rows(records)).toEqual(expected);
    expect(rows([...records].reverse())).toEqual(expected);
    expect(rows([...records].sort(() => 0.5 - Math.random()))).toEqual(expected);
  });

  it('a higher count beats an earlier name', () => {
    expect(rows([...many('Agents', 1), ...many('Safety', 2)])).toEqual([['Safety', 2], ['Agents', 1]]);
  });

  it('Scenario: Other last - Other 4 and Cloud 1 lists Cloud before Other', () => {
    expect(rows([...many('Other', 4), ...many('Cloud', 1)])).toEqual([['Cloud', 1], ['Other', 4]]);
  });

  it('Other is last even when it would come first alphabetically or has the most', () => {
    expect(rows([...many('Other', 9), ...many('Open source', 1), ...many('Agents', 3), ...many('Research', 2)])).toEqual([['Agents', 3], ['Research', 2], ['Open source', 1], ['Other', 9]]);
  });

  it('Scenario: Missing topic - a record whose topic is empty is counted under Other', () => {
    expect(rows([record(''), record('Cloud')])).toEqual([['Cloud', 1], ['Other', 1]]);
  });

  it('a topic that is missing altogether, null, or not text is also Other, and is still counted in the total', () => {
    const noTopic = { article_id: 'x', verified_at: '2026-10-06T10:00:00.000Z' } as unknown as VerifiedRecord;
    const stats = countByTopic([noTopic, record(null), record(undefined), record(42), record({}), record(['Cloud'])]);
    expect(stats.total).toBe(6);
    expect(stats.byTopic).toEqual([{ topic: 'Other', count: 6 }]);
  });

  it('a topic that is not one of the 8 is Other, however it is written', () => {
    for (const unknown of ['Cooking', 'Other', 'agents', 'CLOUD', ' Cloud', 'Cloud ', 'Generative  AI', 'Chips and Hardware', 'Cloud, Agents']) {
      expect(rows([record(unknown)])).toEqual([['Other', 1]]);
    }
  });

  it('each of the 8 interest topics is counted under its own name', () => {
    expect(INTERESTS).toHaveLength(8);
    const stats = countByTopic(INTERESTS.map((topic) => record(topic)));
    expect(stats.total).toBe(8);
    expect(stats.byTopic.map((r) => r.topic)).toEqual([...INTERESTS].sort());
    expect(stats.byTopic.every((r) => r.count === 1)).toBe(true);
  });

  it('Scenario: No records - an empty list is a total of 0 and no rows', () => {
    expect(countByTopic([])).toEqual({ total: 0, byTopic: [] });
  });

  it('topics with no articles are not listed', () => {
    const topics = rows([record('Cloud')]).map(([t]) => t);
    expect(topics).toEqual(['Cloud']);
    expect(countByTopic([record('Cloud')]).byTopic.some((r) => r.count === 0)).toBe(false);
  });

  it('Other is not listed when it has nothing, even though unknown topics are collected there', () => {
    expect(rows([record('Cloud'), record('Agents')]).some(([t]) => t === 'Other')).toBe(false);
  });

  it('the total is the sum of the rows, Other included', () => {
    const stats = countByTopic([...many('Cloud', 3), ...many('Agents', 2), record('???'), record('')]);
    expect(stats.total).toBe(7);
    expect(stats.byTopic.reduce((sum, r) => sum + r.count, 0)).toBe(stats.total);
  });

  it('an article counts once: two records for the same article are one', () => {
    const again: VerifiedRecord = { article_id: 'same', verified_at: '2026-10-06T10:00:00.000Z', topic: 'Cloud' };
    const stats = countByTopic([again, { ...again, verified_at: '2026-10-07T10:00:00.000Z' }, { ...again, topic: 'Agents' }]);
    expect(stats).toEqual({ total: 1, byTopic: [{ topic: 'Cloud', count: 1 }] }); // the first record is the one counted
  });

  it('different articles in the same topic each count', () => {
    expect(countByTopic(many('Cloud', 50))).toEqual({ total: 50, byTopic: [{ topic: 'Cloud', count: 50 }] });
  });

  it('records that are not records are skipped, not counted and not fatal', () => {
    const junk = [null, undefined, 'text', 7, true, []] as unknown as VerifiedRecord[];
    expect(countByTopic([...junk, record('Cloud')])).toEqual({ total: 1, byTopic: [{ topic: 'Cloud', count: 1 }] });
    expect(countByTopic(junk)).toEqual({ total: 0, byTopic: [] });
  });

  it('records with no article id are still counted, each', () => {
    const anon = (topic: string) => ({ verified_at: '2026-10-06T10:00:00.000Z', topic }) as unknown as VerifiedRecord;
    expect(countByTopic([anon('Cloud'), anon('Cloud')]).total).toBe(2);
    expect(countByTopic([{ ...anon('Cloud'), article_id: '' }, { ...anon('Cloud'), article_id: '' }]).total).toBe(2);
  });

  it('does not change what it is given', () => {
    const records = [record('Cloud'), record('Agents'), record('Cloud')];
    const copy = JSON.parse(JSON.stringify(records));
    countByTopic(records);
    expect(records).toEqual(copy);
    expect(() => countByTopic(Object.freeze(records.map((r) => Object.freeze({ ...r }))))).not.toThrow(); // a frozen list of frozen records is fine too
  });

  it('gives the same answer every time, and fresh objects each time', () => {
    const records = [...many('Cloud', 2), ...many('Agents', 2)];
    const first = countByTopic(records);
    const second = countByTopic(records);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    first.byTopic[0].count = 99;
    expect(countByTopic(records).byTopic[0].count).toBe(2);
  });

  it('rows carry only the topic and the count', () => {
    for (const row of countByTopic([record('Cloud'), record('?')]).byTopic) expect(Object.keys(row).sort()).toEqual(['count', 'topic']);
  });

  it('is not tied to the Reading List or the network: it is a plain function of the records', () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    try {
      countByTopic([record('Cloud')]);
    } finally {
      global.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
