/** Pure helpers for the R0 measurement scripts (spec 16, section 3.1). Nothing here calls the network. */

import { DENYLIST, type DenyCategory } from './denylist.ts';

export interface SeedEntry {
  group?: string;
  employer: string;
  domains: string[];
}

/** Application systems shared by many employers: the company is the first path segment, not the host. */
const SHARED_ATS = ['lever.co', 'ashbyhq.com', 'greenhouse.io', 'smartrecruiters.com', 'jobvite.com', 'workable.com'];
/** Application systems that give each employer a subdomain: the company is the first host label. */
const HOSTED_ATS = ['myworkdayjobs.com', 'icims.com', 'eightfold.ai', 'recruitee.com', 'breezy.hr', 'teamtailor.com', 'bamboohr.com'];
/** Official application systems whose pages count as an employer's own posting (spec decision 29). */
export const ATS_DOMAINS = [...SHARED_ATS, ...HOSTED_ATS, 'oraclecloud.com', 'taleo.net', 'successfactors.com', 'successfactors.eu', 'ultipro.com', 'paylocity.com', 'avature.net', 'adp.com'];

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function employerOf(url: string, seed: SeedEntry[]): string {
  const host = hostOf(url);
  if (SHARED_ATS.some((d) => onDomain(host, d))) {
    const slug = new URL(url).pathname.split('/').filter(Boolean)[0] ?? host;
    return seed.find((s) => squash(s.employer) === squash(slug))?.employer ?? slug;
  }
  const hosted = HOSTED_ATS.find((d) => onDomain(host, d));
  if (hosted) {
    const label = host.split('.')[0]!;
    return seed.find((s) => squash(s.employer) === squash(label))?.employer ?? label;
  }
  const hit = seed.find((s) => s.domains.some((d) => onDomain(host, d)));
  return hit ? hit.employer : host.split('.').slice(-2).join('.');
}

/** A denylist entry is a domain, or a domain and path prefix for one account on a shared system. */
function matchesEntry(url: string, host: string, entry: string): boolean {
  const [entryHost, ...path] = entry.split('/');
  if (!onDomain(host, entryHost!)) return false;
  return path.length === 0 || new URL(url).pathname.toLowerCase().startsWith(`/${path.join('/')}`);
}

/** The denylist category a URL falls in, or null. Matches the domain and its subdomains. */
export function denylistReason(url: string): DenyCategory | null {
  const host = hostOf(url);
  for (const [category, domains] of Object.entries(DENYLIST) as [DenyCategory, readonly string[]][])
    if (domains.some((d) => matchesEntry(url, host, d))) return category;
  return null;
}

export const isAggregator = (url: string): boolean => denylistReason(url) !== null;

const CAREER_LABELS = new Set(['careers', 'jobs', 'join', 'apply', 'talent', 'work', 'hiring', 'recruiting']);

/**
 * Only an employer's own career page or an official application system counts as evidence (spec decision 29):
 * a seed company's domain, a known application system, a careers host or a careers path on a company site.
 * Denylisted domains are refused first.
 */
export function isLegitimateSource(url: string, seed: SeedEntry[]): boolean {
  if (denylistReason(url)) return false;
  const host = hostOf(url);
  if (seed.some((s) => s.domains.some((d) => onDomain(host, d)))) return true;
  // An application system's own site is not a posting; its customers' subdomains and accounts are.
  if (ATS_DOMAINS.some((d) => host !== d && onDomain(host, d))) return true;
  if (CAREER_LABELS.has(host.split('.')[0]!) || host.endsWith('.jobs') || host.includes('career') || host.includes('jobs')) return true;
  const segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  return segments.some((seg) => seg === 'careers' || seg === 'career') || segments[0] === 'jobs' || segments[0] === 'job';
}

const LEVEL_WORDS = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'associate', 'i', 'ii', 'iii', 'iv', 'v', '1', '2', '3', '4']);

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const withoutLevels = (words: string[]) => words.filter((w) => !LEVEL_WORDS.has(w));

/** A title as word lists, one per part: split at commas, bars, colons, brackets and dashes, with page text around it dropped. */
function parts(title: string): string[][] {
  const cleaned = title.replace(/^job application for\s+/i, '').replace(/\s+at\s+[^,|:()–—-]+$/i, '');
  return cleaned.split(/[-–—]\s|\s[-–—]\s|[,|:()]/).map(tokens).filter((w) => w.length);
}

const contiguous = (hay: string[], needle: string[]) => hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));

function compare(roleWords: string[], title: string): 'exact' | 'similar' | 'no' {
  const p = parts(title);
  // Each of the first three parts alone, and neighbouring parts joined ("Software Engineer, Backend").
  const candidates = [...p.slice(0, 3), ...[0, 1].filter((i) => p[i + 1]).map((i) => [...p[i]!, ...p[i + 1]!])];
  if (candidates.some((c) => withoutLevels(c).join(' ') === roleWords.join(' '))) return 'exact';
  const near = p.slice(0, 2).flat();
  if (contiguous(near, roleWords) || roleWords.every((w) => near.includes(w))) return 'similar';
  return 'no';
}

/** How a posting's title relates to the role: the same, a known other name for it, something like it, or not it. */
export function matchTitle(role: string, aliases: string[], title: string): 'exact' | 'alias' | 'similar' | 'no' {
  const direct = compare(tokens(role), title);
  if (direct === 'exact') return 'exact';
  if (aliases.some((a) => compare(tokens(a), title) === 'exact')) return 'alias';
  return direct;
}

const HUB_PATH = /\/(careers?|jobs?|search|results?|categor(y|ies)|teams?|locations?|blog|articles?)\/?$|\/(search|results|blog|articles?|category|resources)\b/i;
const DUTIES = /responsibilit|qualification|requirements?\b|what you('|’)ll|you will|about the (role|job|team|position)/i;

/** A single posting, as opposed to a careers hub, a search page or an article: duties and requirements, and enough text. */
const ARTICLE_TITLE = /job description|template|best practices|what (is|does|are)|\bguide\b|how to|salary|beginners|career path|jobs near|interview|\bvs\.? |explained/i;

export function looksLikePosting(url: string, text: string, title = ''): boolean {
  return !HUB_PATH.test(new URL(url).pathname) && !ARTICLE_TITLE.test(title) && text.length >= 1200 && DUTIES.test(text);
}

const EQUAL_OPPORTUNITY = /equal opportunity|equal employment|\bEEO\b|do(es)? not discriminate|without regard to|regardless of (race|color|colour|religion|sex|gender|age|national|disab)|protected veteran|reasonable accommodation|affirmative action|diversity and inclusion statement/i;

/** Drops equal-opportunity and diversity sentences so they are never read as skills (spec decision 19). */
export function stripEqualOpportunity(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !EQUAL_OPPORTUNITY.test(sentence))
    .join(' ');
}

export const normSkill = (s: string) => s.toLowerCase().replace(/[.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim();

export type Band = 'high' | 'medium' | 'low';
export const BANDS = { high: 0.6, medium: 0.25, minMentions: 2 };

/** Share of postings that mention each skill, once per posting; a skill needs two mentions to be kept. */
export function rankSkills(postings: { skills: string[] }[]) {
  const counts = new Map<string, number>();
  for (const p of postings) for (const skill of new Set(p.skills.map(normSkill).filter(Boolean))) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  const of = postings.length;
  return [...counts]
    .filter(([, mentions]) => mentions >= BANDS.minMentions)
    .map(([skill, mentions]) => {
      const share = mentions / of;
      const band: Band = share >= BANDS.high ? 'high' : share >= BANDS.medium ? 'medium' : 'low';
      return { skill, mentions, of, share, band };
    })
    .sort((a, b) => b.mentions - a.mentions || a.skill.localeCompare(b.skill));
}
