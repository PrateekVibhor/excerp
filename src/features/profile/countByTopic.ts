import { INTERESTS, OTHER_TOPIC, type VerifiedRecord } from '../../data/types';

export interface TopicCount {
  topic: string;
  count: number;
}

export interface VerifiedStats {
  /** How many articles the reader has verified. */
  total: number;
  /** Topics with at least one article: most first, ties by name, and "Other" last. */
  byTopic: TopicCount[];
}

const KNOWN: ReadonlySet<string> = new Set(INTERESTS);

/**
 * Counts verified articles by topic, from the reader's own records.
 *
 * - A record whose topic is one of the 8 interest topics counts under it. A missing, empty or any other value counts
 *   under "Other". The topic text is the one stored with the record, so nothing here depends on the article still
 *   being available from the server.
 * - An article counts once, whatever the records say (the store keeps one per article already).
 * - Topics with no articles are left out. "Other" always comes last, however many it has.
 */
export function countByTopic(records: readonly VerifiedRecord[]): VerifiedStats {
  const counts = new Map<string, number>();
  const articles = new Set<string>();
  let total = 0;

  for (const record of records) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue; // not a record: nothing to count
    const id = (record as { article_id?: unknown }).article_id;
    if (typeof id === 'string' && id !== '') {
      if (articles.has(id)) continue;
      articles.add(id);
    }
    const stored = (record as { topic?: unknown }).topic;
    const topic = typeof stored === 'string' && KNOWN.has(stored) ? stored : OTHER_TOPIC;
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
    total++;
  }

  const byTopic = [...counts]
    .filter(([topic]) => topic !== OTHER_TOPIC)
    .map(([topic, count]) => ({ topic, count }))
    // Plain character order, so the result is the same on every device whatever its language settings.
    .sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
  const other = counts.get(OTHER_TOPIC) ?? 0;
  if (other > 0) byTopic.push({ topic: OTHER_TOPIC, count: other });

  return { total, byTopic };
}
