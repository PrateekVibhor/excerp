import { SOURCE_COMPANIES, type SourceCompany } from '../../src/data/types.ts';
import { loadConfig, TAGS } from './config.ts';
import { createArticleStore, createDb, type ArticleStore, type NewArticle } from './db.ts';
import { createNebiusChat, summarize as summarizeWithModel, type ArticleInput, type SummarizeResult } from './llm.ts';
import { generateQuiz, type QuizGeneration } from './quiz.ts';
import { searchCompany, type SearchResult } from './tavily.ts';

/** One structured log line. Never carries a key or the article text. */
export type LogEvent = Record<string, unknown> & { event: string };

export interface PipelineDeps {
  search: (company: SourceCompany) => Promise<SearchResult>;
  summarize: (article: ArticleInput, company: SourceCompany) => Promise<SummarizeResult>;
  /** Makes the quiz and topic for a stored summary. Left out, articles are stored without a quiz. */
  makeQuiz?: (summary: string) => Promise<QuizGeneration>;
  store: ArticleStore;
  maxPerCompany: number;
  log: (event: LogEvent) => void;
  now?: () => Date;
  readerCount?: () => number;
  companies?: readonly SourceCompany[];
}

export interface CompanyReport {
  found: number;
  stored: number;
  skipped: Record<string, number>;
  error?: string;
}

export interface RunReport {
  stored: number;
  companies: Partial<Record<SourceCompany, CompanyReport>>;
  startedAt: string;
  finishedAt: string;
}

/** Same article, same key: drops the query string, fragment and trailing slash. */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

const SITE_WORDS = /\b(blog|news|newsroom|engineering|research|insights|technical|developer|artificial intelligence|help center)\b/i;
/** Separators sites put between the headline and their own name. */
const SEPARATOR = /\s+[|\\/–—-]\s+(?=[^|\\/–—-]*$)/;

/** Removes trailing site names such as " | NVIDIA Technical Blog" or " \ Anthropic". */
export function cleanTitle(title: string, company: SourceCompany): string {
  let current = title.trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) {
    const match = current.match(SEPARATOR);
    if (!match || match.index === undefined) break;
    const head = current.slice(0, match.index).trim();
    const tail = current.slice(match.index + match[0].length).trim();
    const isSiteName = tail.length <= 40 && (tail.toLowerCase().includes(company.toLowerCase()) || SITE_WORDS.test(tail) || /google|meta|amazon|aws|openai|anthropic|nvidia|microsoft|deepmind|mckinsey|bcg|bain|cfa|harvard|hbr|mit sloan|blackrock|world economic forum|y combinator|sequoia|andreessen|a16z|general catalyst/i.test(tail));
    if (!isSiteName || head.length < 10) break;
    current = head;
  }
  // Y Combinator names its section after a colon, not a separator: "How To Pick A Startup Idea : YC Startup Library".
  return current.replace(/\s*:\s*YC Startup Library$/i, '');
}

/** A new article has no readers. The number shown to readers is counted from real activity, never invented. */
const defaultReaderCount = () => 0;

/**
 * One pipeline run. For each company: search, drop undated and already stored items,
 * summarize newest first, and store up to `maxPerCompany`. A failure is logged and the
 * run moves on; nothing here throws for a single company or article.
 */
export async function runPipeline(deps: PipelineDeps): Promise<RunReport> {
  const { search, summarize, makeQuiz, store, maxPerCompany, log, now = () => new Date(), readerCount = defaultReaderCount, companies = SOURCE_COMPANIES } = deps;
  const startedAt = now().toISOString();
  const report: RunReport = { stored: 0, companies: {}, startedAt, finishedAt: startedAt };
  log({ event: 'run_started', companies: companies.length, maxPerCompany });

  for (const company of companies) {
    const cr: CompanyReport = { found: 0, stored: 0, skipped: {} };
    report.companies[company] = cr;
    const skip = (url: string, reason: string, extra: Record<string, unknown> = {}) => {
      cr.skipped[reason] = (cr.skipped[reason] ?? 0) + 1;
      log({ event: 'skipped', company, url, reason, ...extra });
    };

    let found: SearchResult;
    try {
      found = await search(company);
    } catch (error) {
      cr.error = (error as Error).message;
      log({ event: 'search_failed', company, reason: cr.error });
      continue;
    }
    cr.found = found.kept.length;
    for (const d of found.dropped) skip(d.url, d.reason);

    // Undated items are skipped (intent-3 open question 2, default); duplicates collapse onto one URL.
    const candidates = new Map<string, (typeof found.kept)[number] & { publishedAt: string }>();
    for (const item of found.kept) {
      if (item.publishedAt === null) {
        skip(item.url, 'no published date');
        continue;
      }
      const url = normalizeUrl(item.url);
      if (candidates.has(url)) skip(item.url, 'duplicate in this search');
      else candidates.set(url, { ...item, url, publishedAt: item.publishedAt });
    }

    let known: Set<string>;
    try {
      known = await store.existingUrls([...candidates.keys()]);
    } catch (error) {
      cr.error = `database: ${(error as Error).message}`;
      log({ event: 'database_failed', company, reason: cr.error });
      continue;
    }

    const fresh = [...candidates.values()]
      .filter((c) => (known.has(c.url) ? (skip(c.url, 'already stored'), false) : true))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

    for (const item of fresh) {
      if (cr.stored >= maxPerCompany) {
        skip(item.url, 'over the per-run cap');
        continue;
      }
      const title = cleanTitle(item.title, company);
      const result = await summarize({ title, url: item.url, text: item.text }, company);
      if (!result.ok) {
        skip(item.url, 'summary rejected', { failures: result.failures });
        continue;
      }
      if (result.failures.length > 0) log({ event: 'summary_retried', company, url: item.url, failures: result.failures });

      // A quiz never blocks an article: any failure here leaves quiz and topic null and the article is stored.
      let quiz: NewArticle['quiz'] = null;
      let topic: NewArticle['topic'] = null;
      if (makeQuiz) {
        try {
          const made = await makeQuiz(result.value.summary);
          if (made.ok) {
            quiz = made.value.quiz;
            topic = made.value.topic;
            if (made.failures.length > 0) log({ event: 'quiz_retried', company, url: item.url, failures: made.failures });
          } else {
            log({ event: 'quiz_rejected', company, url: item.url, attempts: made.attempts, failures: made.failures });
          }
        } catch (error) {
          log({ event: 'quiz_rejected', company, url: item.url, attempts: 0, failures: [`quiz step failed: ${(error as Error).message}`] });
        }
      }
      try {
        const inserted = await store.insert({
          source_company: company,
          source_url: item.url,
          content_type: result.value.content_type,
          title,
          summary: result.value.summary,
          published_at: item.publishedAt,
          fetched_at: now().toISOString(),
          reader_count: readerCount(),
          quiz,
          topic,
        });
        if (inserted) {
          cr.stored++;
          report.stored++;
          log({ event: 'stored', company, url: item.url, content_type: result.value.content_type, attempts: result.attempts, quiz: quiz !== null, topic });
        } else {
          skip(item.url, 'already stored');
        }
      } catch (error) {
        skip(item.url, 'insert failed', { error: (error as Error).message });
      }
    }
    log({ event: 'company_done', company, found: cr.found, stored: cr.stored, skipped: cr.skipped });
  }

  report.finishedAt = now().toISOString();
  log({ event: 'run_finished', stored: report.stored, startedAt: report.startedAt, finishedAt: report.finishedAt });
  return report;
}

/** The real dependencies: Tavily, Nemotron on Nebius, and Postgres. */
export function realDeps(config = loadConfig()) {
  const db = createDb(config.databaseUrl);
  const chat = createNebiusChat({ apiKey: config.nebiusApiKey, model: config.nebiusModel });
  const deps: PipelineDeps = {
    search: (company) => searchCompany(company, { apiKey: config.tavilyApiKey }),
    summarize: (article, company) => summarizeWithModel(article, chat, { tags: TAGS[company] }),
    makeQuiz: (summary) => generateQuiz(summary, chat),
    store: createArticleStore(db.pool),
    maxPerCompany: config.maxPerCompany,
    log: (event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })),
  };
  return { deps, db };
}

if (import.meta.main) {
  const { deps, db } = realDeps();
  try {
    const report = await runPipeline(deps);
    console.log(JSON.stringify({ event: 'report', ...report }));
  } finally {
    await db.close();
  }
}
