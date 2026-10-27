import type { ContentType, SourceCompany } from '../../src/data/types.ts';

/**
 * Where each company publishes articles, as host[/path] patterns. The host must match
 * exactly (a leading "www." is ignored), so subdomains such as forums, docs, help and
 * community sites are excluded. "*" matches one path segment. An article's address
 * must go at least one segment beyond its pattern, so the pattern's own index page
 * does not count.
 */
export const SOURCES: Record<SourceCompany, string[]> = {
  NVIDIA: ['blogs.nvidia.com/blog', 'developer.nvidia.com/blog', 'nvidianews.nvidia.com/news', 'research.nvidia.com/publication'],
  Google: ['blog.google', 'research.google/blog', 'deepmind.google/blog', 'deepmind.google/discover/blog'],
  Meta: ['ai.meta.com/blog', 'ai.meta.com/research/publications', 'about.fb.com/news', 'engineering.fb.com'],
  OpenAI: ['openai.com/index', 'openai.com/research'],
  Anthropic: ['anthropic.com'],
  AWS: ['aws.amazon.com/blogs/*', 'aws.amazon.com/about-aws/whats-new'],
  Microsoft: [
    'blogs.microsoft.com',
    'news.microsoft.com',
    'devblogs.microsoft.com',
    'azure.microsoft.com/*/blog',
    // www. matters here: Tavily treats a bare microsoft.com as every Microsoft subdomain (learn, docs, technet).
    'www.microsoft.com/*/research/blog',
    'www.microsoft.com/*/research/publication',
  ],

  // Business and Finance. Every pattern below was seen to return real articles in a Tavily search
  // (October 2026); the exact host still has to match, so careers, jobs, store, news and community
  // sites of the same organizations are out.
  McKinsey: ['mckinsey.com/capabilities/*/our-insights', 'mckinsey.com/industries/*/our-insights', 'mckinsey.com/mgi/our-research'],
  BCG: ['bcg.com/publications', 'bcg.com/press'],
  'Bain & Company': ['bain.com/insights'],
  'CFA Institute': ['cfainstitute.org/insights/articles', 'rpc.cfainstitute.org/blogs/enterprising-investor'],
  // Paywalled: Tavily returns the short /product/ preview page, not the full article. Kept on purpose.
  'Harvard Business Review': ['hbr.org/product'],
  'MIT Sloan Management Review': ['sloanreview.mit.edu/article', 'sloanreview.mit.edu/projects'],
  BlackRock: ['blackrock.com/us/financial-professionals/insights', 'blackrock.com/us/individual/literature/market-commentary'],
  'World Economic Forum': ['weforum.org/stories', 'reports.weforum.org/docs'],
  // Its articles live under /library; /blog is rare. Nothing newer than the window is returned right now.
  'Y Combinator': ['ycombinator.com/library', 'ycombinator.com/blog'],
  'Sequoia Capital': ['sequoiacap.com/article'],
  // Posts sit directly under the host, so the whole host is the pattern; section pages are filtered separately.
  'Andreessen Horowitz': ['a16z.com'],
  // UNVERIFIED: Tavily returned only team and job pages for generalcatalyst.com, so these paths are a guess
  // and nothing is expected to match yet. Each run still spends one search on it.
  'General Catalyst': ['generalcatalyst.com/stories', 'generalcatalyst.com/perspectives'],
};

export const TECH_TYPES: readonly ContentType[] = ['Research Paper', 'White Paper', 'Tech Blog', 'Release'];
export const BUSINESS_TYPES: readonly ContentType[] = ['Consulting', 'Finance', 'Venture Capital'];

/** True for the seven tech companies, whose articles are typed Research Paper, White Paper, Tech Blog or Release. */
export const isTechCompany = (company: SourceCompany): boolean => TAGS[company] === TECH;

/** How an article's content type is decided: always the same tag, or chosen by the model from a list. */
export type TagRule = { fixed: ContentType } | { choose: readonly ContentType[] };

const TECH: TagRule = { choose: TECH_TYPES };
const BUSINESS: TagRule = { choose: BUSINESS_TYPES };

/**
 * Tags by source. The seven tech companies let the model pick one of four types. Most business
 * sources have one tag; Harvard Business Review, MIT Sloan Management Review and the World Economic
 * Forum write across several areas, so the model picks Consulting, Finance or Venture Capital per article.
 */
export const TAGS: Record<SourceCompany, TagRule> = {
  NVIDIA: TECH,
  Google: TECH,
  Meta: TECH,
  OpenAI: TECH,
  Anthropic: TECH,
  AWS: TECH,
  Microsoft: TECH,
  McKinsey: { fixed: 'Consulting' },
  BCG: { fixed: 'Consulting' },
  'Bain & Company': { fixed: 'Consulting' },
  'CFA Institute': { fixed: 'Finance' },
  BlackRock: { fixed: 'Finance' },
  'Y Combinator': { fixed: 'Venture Capital' },
  'Sequoia Capital': { fixed: 'Venture Capital' },
  'Andreessen Horowitz': { fixed: 'Venture Capital' },
  'General Catalyst': { fixed: 'Venture Capital' },
  'Harvard Business Review': BUSINESS,
  'MIT Sloan Management Review': BUSINESS,
  'World Economic Forum': BUSINESS,
};

/** The wording sent to Tavily when the generic one for a source group is not enough; each was tried for real. */
export const SEARCH_QUERIES: Partial<Record<SourceCompany, string>> = {
  'MIT Sloan Management Review': 'MIT Sloan Management Review article: how organizations adopt AI, leadership and strategy research',
  'CFA Institute': 'Enterprising Investor CFA Institute blog on AI and investment management',
  BlackRock: 'BlackRock Investment Institute weekly commentary, market outlook and investment insights',
  'Y Combinator': 'Y Combinator blog post: advice for founders and startups, essay on building companies with AI',
  'Sequoia Capital': 'Sequoia Capital article essay on AI, startups and founders',
  'General Catalyst': 'General Catalyst stories and perspectives on AI, health assurance and venture investing',
};

/** The hosts to give Tavily's include_domains for a company: the hosts of its source patterns. */
export function tavilyDomains(company: SourceCompany): string[] {
  return [...new Set(SOURCES[company].map((pattern) => pattern.split('/')[0]))];
}

export interface Config {
  tavilyApiKey: string;
  nebiusApiKey: string;
  nebiusModel: string;
  databaseUrl: string;
  runIntervalMinutes: number;
  /** Run the pipeline as soon as the worker starts, instead of waiting one interval. */
  runOnStart: boolean;
  /** How often the worker refreshes list courses after the reference library changes. Left out (or "off"), the scheduled refresh is off: only a reader's "Refresh now" checks a list. */
  listRefreshMinutes?: number;
  /** How often the worker looks for queued course work (a search for a course's sources, or its build). Left out, the worker does not run courses. */
  courseRunnerSeconds?: number;
  /** The most search credits a source search may use, and the most a build may use, so one course costs at most the two together. */
  courseFindCredits: number;
  courseBuildCredits: number;
  /** A smaller model for the page judge, which is asked the most. Unset: the main model judges. */
  nebiusJudgeModel?: string;
  maxPerCompany: number;
  port: number;
  /** Addresses of a proxy in front of the API whose X-Forwarded-For is believed. Empty: nothing is trusted. */
  trustProxy: string[];
  /** The Google web client id that sign-in tokens must be made for. Left out, Google sign-in is off. */
  googleWebClientId?: string;
  /** Any verified Google account counts as approved, whatever the allow-list says. For a demo; off unless asked for. */
  allowAnyGoogleAccount: boolean;
  /** The app's bundle id: what an Apple sign-in token must be made for. */
  appleBundleId: string;
  /** To revoke a reader's Apple access when their account is deleted: the developer team id, the key id, and the key (its contents, or the path of the .p8 file). All from the environment, never in code; without them nothing is revoked. */
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  applePrivateKeyPath?: string;
  /** A file that records the hash of each deleted account, on a volume outside the database and its backups. Left out, none is written. */
  deletionLogPath?: string;
}

const REQUIRED = ['TAVILY_API_KEY', 'NEBIUS_API_KEY', 'NEBIUS_MODEL', 'DATABASE_URL'] as const;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`);
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Reads configuration from the environment. Errors name the missing or invalid
 * variables but never echo a value, so a key cannot leak into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    tavilyApiKey: env.TAVILY_API_KEY!.trim(),
    nebiusApiKey: env.NEBIUS_API_KEY!.trim(),
    nebiusModel: env.NEBIUS_MODEL!.trim(),
    databaseUrl: env.DATABASE_URL!.trim(),
    runIntervalMinutes: positiveInt(env, 'RUN_INTERVAL_MINUTES', 1440),
    runOnStart: booleanFlag(env, 'RUN_ON_START', true),
    listRefreshMinutes: ['', 'off'].includes(env.LIST_REFRESH_MINUTES?.trim().toLowerCase() ?? '') ? undefined : positiveInt(env, 'LIST_REFRESH_MINUTES', 0),
    courseRunnerSeconds: env.COURSE_RUNNER_SECONDS?.trim() ? positiveInt(env, 'COURSE_RUNNER_SECONDS', 0) : undefined,
    courseFindCredits: positiveInt(env, 'COURSE_FIND_CREDITS', 20),
    courseBuildCredits: positiveInt(env, 'COURSE_BUILD_CREDITS', 40),
    nebiusJudgeModel: env.NEBIUS_JUDGE_MODEL?.trim() || undefined,
    maxPerCompany: positiveInt(env, 'MAX_PER_COMPANY', 3),
    port: positiveInt(env, 'PORT', 8080),
    googleWebClientId: env.GOOGLE_WEB_CLIENT_ID?.trim() || undefined,
    allowAnyGoogleAccount: booleanFlag(env, 'ALLOW_ANY_GOOGLE_ACCOUNT', false),
    appleBundleId: env.APPLE_BUNDLE_ID?.trim() || 'com.prateekvibhor.excerp',
    appleTeamId: env.APPLE_TEAM_ID?.trim() || undefined,
    appleKeyId: env.APPLE_KEY_ID?.trim() || undefined,
    applePrivateKey: env.APPLE_PRIVATE_KEY?.trim().replace(/\\n/g, '\n') || undefined,
    applePrivateKeyPath: env.APPLE_PRIVATE_KEY_PATH?.trim() || undefined,
    deletionLogPath: env.DELETION_LOG_PATH?.trim() || undefined,
    trustProxy: (env.TRUST_PROXY ?? '').split(',').map((a) => a.trim()).filter(Boolean),
  };
}
