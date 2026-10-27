import type { Quiz } from '../../src/data/types.ts';
import pg from 'pg';
import { READER_COUNT_SQL, READER_WINDOW_DAYS } from './social.ts';

export interface Db {
  /** Resolves when the database answers; rejects when it does not. */
  ping(): Promise<void>;
  close(): Promise<void>;
  pool: pg.Pool;
}

export function createDb(databaseUrl: string): Db {
  // A short connection timeout keeps /health quick when the database is down.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (error) => console.error('Postgres pool error:', error.message));
  return {
    pool,
    async ping() {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}

/** A row for the articles table. Timestamps are ISO 8601 strings. */
export interface NewArticle {
  source_company: string;
  source_url: string;
  content_type: string;
  title: string;
  summary: string;
  published_at: string;
  fetched_at: string;
  reader_count: number;
  /** Feature 8. Null (or left out) when no valid quiz could be made; the article is stored anyway. */
  quiz?: Quiz | null;
  topic?: string | null;
}

export interface ArticleStore {
  /** Which of these URLs are already stored. */
  existingUrls(urls: string[]): Promise<Set<string>>;
  /** Stores the article; resolves false if its URL was already there. */
  insert(article: NewArticle): Promise<boolean>;
}

export function createArticleStore(pool: pg.Pool): ArticleStore {
  return {
    async existingUrls(urls) {
      if (urls.length === 0) return new Set();
      const { rows } = await pool.query<{ source_url: string }>('SELECT source_url FROM articles WHERE source_url = ANY($1)', [urls]);
      return new Set(rows.map((r) => r.source_url));
    },
    async insert(a) {
      const { rowCount } = await pool.query(
        `INSERT INTO articles (source_company, source_url, content_type, title, summary, published_at, fetched_at, reader_count, quiz, topic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (source_url) DO NOTHING`,
        [a.source_company, a.source_url, a.content_type, a.title, a.summary, a.published_at, a.fetched_at, a.reader_count, a.quiz ? JSON.stringify(a.quiz) : null, a.topic ?? null],
      );
      return rowCount === 1;
    },
  };
}

/** An article in the app's Article shape (src/data/types.ts), dates as ISO strings. */
export interface ArticleRow {
  id: string;
  source_company: string;
  source_url: string;
  content_type: string;
  title: string;
  summary: string;
  published_at: string;
  fetched_at: string;
  reader_count: number;
  /** Feature 8. Always present in the response, null when the article has no quiz or topic. */
  quiz: Quiz | null;
  topic: string | null;
}

export interface ArticleReader {
  /** Newest published first, at most `limit`. */
  feed(limit: number): Promise<ArticleRow[]>;
  /** The article, or undefined when the id is unknown or not a valid id. */
  getById(id: string): Promise<ArticleRow | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, source_company, source_url, content_type, title, summary, published_at, fetched_at, reader_count, quiz, topic';

interface DbRow extends Omit<ArticleRow, 'published_at' | 'fetched_at'> {
  published_at: Date;
  fetched_at: Date;
}

const toArticle = (r: DbRow): ArticleRow => ({
  id: r.id,
  source_company: r.source_company,
  source_url: r.source_url,
  content_type: r.content_type,
  title: r.title,
  summary: r.summary,
  published_at: r.published_at.toISOString(),
  fetched_at: r.fetched_at.toISOString(),
  reader_count: r.reader_count,
  quiz: r.quiz ?? null,
  topic: r.topic ?? null,
});

const DAY_MS = 86_400_000;
/** The articles' columns as readers see them: `reader_count` is counted from real saves and verifications, not the stored number. */
const READER_COLUMNS = COLUMNS.replace('reader_count', `${READER_COUNT_SQL('articles.id', '$2')} AS reader_count`);

export function createArticleReader(pool: pg.Pool, now: () => Date = () => new Date()): ArticleReader {
  const windowStart = () => new Date(now().getTime() - READER_WINDOW_DAYS * DAY_MS);
  return {
    async feed(limit) {
      const { rows } = await pool.query<DbRow>(
        // fetched_at and id break ties so the order is stable between calls.
        `SELECT ${READER_COLUMNS} FROM articles ORDER BY published_at DESC, fetched_at DESC, id LIMIT $1`,
        [limit, windowStart()],
      );
      return rows.map(toArticle);
    },
    async getById(id) {
      if (!UUID.test(id)) return undefined;
      const { rows } = await pool.query<DbRow>(`SELECT ${READER_COLUMNS} FROM articles WHERE id = $1`, [id, windowStart()]);
      return rows[0] ? toArticle(rows[0]) : undefined;
    },
  };
}

/** An article that still needs a quiz: just what the model is shown, plus where to find it in the logs. */
export interface MissingQuiz {
  id: string;
  source_url: string;
  summary: string;
}

export interface BackfillStore {
  /** How many articles have no quiz. */
  countMissing(): Promise<number>;
  /** Up to `limit` articles without a quiz whose id comes after `afterId`, in id order. */
  listMissing(limit: number, afterId?: string): Promise<MissingQuiz[]>;
  /** Sets the quiz and topic only if the article still has no quiz. Resolves false when it already has one. */
  setQuiz(id: string, quiz: Quiz, topic: string | null): Promise<boolean>;
}

export function createBackfillStore(pool: pg.Pool): BackfillStore {
  return {
    async countMissing() {
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM articles WHERE quiz IS NULL');
      return rows[0].n;
    },
    async listMissing(limit, afterId) {
      const { rows } = await pool.query<MissingQuiz>(
        `SELECT id, source_url, summary FROM articles WHERE quiz IS NULL AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT $1`,
        [limit, afterId ?? null],
      );
      return rows;
    },
    async setQuiz(id, quiz, topic) {
      // Never overwrites: if a quiz arrived since the article was listed, nothing changes.
      const { rowCount } = await pool.query('UPDATE articles SET quiz = $2::jsonb, topic = $3 WHERE id = $1 AND quiz IS NULL', [id, JSON.stringify(quiz), topic]);
      return rowCount === 1;
    },
  };
}
