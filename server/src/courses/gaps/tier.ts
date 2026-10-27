// Source finder: a suggested tier from who publishes a page, and the pages never used as sources. Both are suggestions and filters only; a page still has
// to be opened, judged for its audience, and shown to teach the skill.
import { DENYLIST } from '../pipeline/denylist.ts';

const INSTITUTIONAL = ['iiba.org', 'pmi.org', 'ieee.org', 'iso.org', 'w3.org', 'omg.org', 'nist.gov', 'acm.org', 'scrum.org', 'scrumguides.org', 'agilealliance.org', 'bcs.org', 'istqb.org', 'ireb.org', 'dama.org', 'ansi.org', 'oecd.org', 'europa.eu'];
const VENDOR = [
  'learn.microsoft.com', 'support.microsoft.com', 'docs.microsoft.com', 'atlassian.com', 'docs.snowflake.com', 'docs.databricks.com', 'databricks.com', 'cloud.google.com', 'support.google.com',
  'docs.aws.amazon.com', 'aws.amazon.com', 'postgresql.org', 'dev.mysql.com', 'sqlite.org', 'developer.mozilla.org', 'support.apple.com', 'docs.github.com', 'docs.gitlab.com', 'oracle.com', 'ibm.com',
];
/** Never a source for learners: job boards and staffing sites (the posting-discovery lists), social posts, forums, video pages (videos are handled apart) and paywalled blog hosts. */
const NOT_SOURCES = [...DENYLIST.aggregator, ...DENYLIST.staffing, 'reddit.com', 'quora.com', 'medium.com', 'facebook.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'pinterest.com', 'tiktok.com', 'instagram.com', 'substack.com', 'slideshare.net', 'scribd.com', 'course-hero.com', 'coursehero.com', 'chegg.com'];

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function suggestTier(url: string): { tier: 1 | 2 | 3; layer: 'institutional' | 'practical'; perspective: 'canonical' | 'field' } {
  const host = hostOf(url);
  if (host && (host.endsWith('.gov') || host.endsWith('.edu') || INSTITUTIONAL.some((d) => within(host, d)))) return { tier: 1, layer: 'institutional', perspective: 'canonical' };
  if (host && VENDOR.some((d) => within(host, d))) return { tier: 2, layer: 'practical', perspective: 'field' };
  return { tier: 3, layer: 'practical', perspective: 'field' };
}

/** Why a page may not be used as a source, or null when it may. */
export function finderDenied(url: string): string | null {
  const host = hostOf(url);
  if (!host) return 'not a web address';
  if (NOT_SOURCES.some((d) => within(host, d))) return 'a job board, social, forum or video site: not used as a source';
  const path = new URL(url).pathname.toLowerCase();
  // Not learning material wherever it is hosted: job descriptions, careers pages, interview-question lists, and course or pricing sales pages.
  if (/^(jobs|careers)\./.test(host) || /(^|[/.-])(job-?descriptions?|job-desc|careers?|jobs?|interview-questions?|resumes?|hire)([/.-]|$)/.test(path)) return 'a job description, careers or interview page: not used as a source';
  if (/(^|\/)(courses?|tracks?|bootcamps?|pricing|enroll|certification-courses?)(\/|$)/.test(path)) return 'a course or pricing page: not used as a source';
  return null;
}

export const FINDER_EXCLUDE_DOMAINS = NOT_SOURCES.filter((d) => !d.includes('/'));
