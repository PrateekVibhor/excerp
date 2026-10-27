import type { SourceCompany } from '../../src/data/types.ts';
import { isTechCompany, SEARCH_QUERIES, SOURCES, tavilyDomains } from './config.ts';

/**
 * The least page text, in characters (about 250 words), that counts as an article. Section hubs, empty
 * extractions and one-line stubs are shorter; it applies to every source alike.
 */
export const MIN_ARTICLE_CHARS = 1500;

export interface FoundArticle {
  company: SourceCompany;
  url: string;
  title: string;
  /** ISO 8601, or null when Tavily gave no usable date. The pipeline skips undated items. */
  publishedAt: string | null;
  /** Page text to summarize: the full page when Tavily has it, otherwise its short snippet. */
  text: string;
}

export interface SearchResult {
  kept: FoundArticle[];
  /** Results dropped here, with the reason, so a run can be checked and tuned. */
  dropped: { url: string; reason: string }[];
}

export interface TavilyOptions {
  apiKey: string;
  /** Results to ask for. One basic search costs one credit whatever this is. */
  maxResults?: number;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, '');

function parseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the URL is under one of the patterns (see SOURCES in config.ts). */
export function isApprovedSource(url: string, patterns: readonly string[]): boolean {
  const parsed = parseWebUrl(url);
  if (!parsed) return false;
  const host = stripWww(parsed.hostname);
  const segments = parsed.pathname.split('/').filter(Boolean);
  return patterns.some((pattern) => {
    const [patternHost, ...patternPath] = pattern.split('/').filter(Boolean);
    if (stripWww(patternHost) !== host) return false;
    if (segments.length <= patternPath.length) return false; // must go beyond the pattern itself
    return patternPath.every((part, i) => part === '*' || part.toLowerCase() === segments[i].toLowerCase());
  });
}

/** Segments that mark a listing page wherever they appear. */
const LISTING_SEGMENTS = new Set(['category', 'categories', 'tag', 'tags', 'topic', 'topics', 'search', 'page', 'author', 'authors']);
/** Final segments that are section or site pages, not articles. */
const SECTION_PAGES = new Set([
  'news', 'blog', 'blogs', 'research', 'index', 'articles', 'article', 'insights', 'ai', 'home', 'about', 'latest', 'all',
  'archive', 'archives', 'publications', 'press', 'stories', 'updates', 'whats-new', 'overview', 'transparency', 'careers',
  'jobs', 'pricing', 'company', 'legal', 'contact', 'events', 'customers', 'newsroom', 'resources',
  'team', 'portfolio', 'people', 'partners', 'investors', 'our-team',
]);

/** Index, section and listing pages ("/news", "/blog/", "/category/ai/...") are not articles. */
export function looksLikeArticle(url: string): boolean {
  const parsed = parseWebUrl(url);
  if (!parsed) return false;
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase().replace(/\.html?$/, ''));
  const last = segments.at(-1);
  if (last === undefined || last.length < 3) return false;
  if (segments.some((s) => LISTING_SEGMENTS.has(s))) return false;
  return !SECTION_PAGES.has(last);
}

/** Tavily dates look like "Mon, 28 Sep 2026 08:55:00 GMT". Returns ISO, or null if unusable. */
export function toIsoDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  if (time > now + 24 * 60 * 60 * 1000) return null; // a date in the future is not believable
  return new Date(time).toISOString();
}

export function queryFor(company: SourceCompany): string {
  const specific = SEARCH_QUERIES[company];
  if (specific) return specific;
  if (isTechCompany(company)) return `${company} latest research papers, technical blog posts, white papers and product releases about AI`;
  return `${company} latest articles and insights on AI, business, finance and technology`;
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string | null;
  published_date?: string;
}

/** Searches one company's official domains and returns the usable results. */
export async function searchCompany(company: SourceCompany, options: TavilyOptions): Promise<SearchResult> {
  const { apiKey, maxResults = 10, timeRange = 'month', timeoutMs = 30_000, fetchFn = fetch } = options;
  const patterns = SOURCES[company];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: { results?: TavilyResult[] };
  try {
    const res = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryFor(company),
        search_depth: 'basic',
        topic: 'general',
        max_results: maxResults,
        time_range: timeRange,
        include_domains: tavilyDomains(company),
        include_published_date: true,
        include_raw_content: 'text',
        include_answer: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Tavily answered HTTP ${res.status}`);
    body = (await res.json()) as { results?: TavilyResult[] };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`Tavily gave no reply within ${timeoutMs / 1000} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const kept: FoundArticle[] = [];
  const dropped: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const r of body.results ?? []) {
    const url = (r.url ?? '').trim();
    const title = (r.title ?? '').trim();
    const text = r.raw_content?.trim() || r.content?.trim() || '';
    if (!url || !title) {
      dropped.push({ url: url || '(no url)', reason: 'missing url or title' });
    } else if (!isApprovedSource(url, patterns)) {
      dropped.push({ url, reason: 'not an approved source' });
    } else if (!looksLikeArticle(url)) {
      dropped.push({ url, reason: 'index or listing page' });
    } else if (text.length < MIN_ARTICLE_CHARS) {
      dropped.push({ url, reason: 'too short' });
    } else if (seen.has(url)) {
      dropped.push({ url, reason: 'duplicate in this search' });
    } else {
      seen.add(url);
      kept.push({ company, url, title, publishedAt: toIsoDate(r.published_date), text });
    }
  }
  return { kept, dropped };
}
