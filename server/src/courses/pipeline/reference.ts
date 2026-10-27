// Plan 16, phase 4, stage 6: reference research for one concept (spec 16, section 6, stage 6). One search for pages (a second only when a fact
// still has one publisher), each page judged before use, facts checked against the page text and the two-publisher rule, and two to four
// "go deeper" resources that mix articles or blogs with up to two videos. Nothing here touches criticality.
import type { Chat } from '../../llm.ts';
import type { SearchClient, Hit } from './postings.ts';
import type { RunIO } from './run.ts';
import { extractFacts, judgePage, publisherOf, verifyFacts, type DroppedFact, type Page, type PageVerdict, type VerifiedFact } from './sourceQuality.ts';
import { findVideos, type YoutubeClient } from './video.ts';

/** Judges one page for one concept. The build gives one that remembers verdicts and may use a separate model; without it the page is judged by `chat`. */
export type Judge = (input: { role: string; concept: string; page: Page; domain?: string }) => Promise<PageVerdict>;

export interface ReferenceInput {
  role: string;
  concept: string;
  search: SearchClient;
  chat: Chat;
  youtube: YoutubeClient;
  /** Whether a page can still be opened. */
  reachable: (url: string) => Promise<boolean>;
  judge?: Judge;
  io: RunIO;
  now: Date;
  /** The industry the course's postings sit in, and the concept's strongest alternate term: both go into the queries and the page and fact prompts. */
  domain?: string;
  alternate?: string;
}

export interface ResourceRow {
  kind: 'article' | 'blog' | 'video';
  title: string;
  source: string;
  url: string;
  why: string;
}

const MAX_RESOURCES = 4;
const MIN_RESOURCES = 2;
const MAX_VIDEOS = 2;

export async function referenceFor(input: ReferenceInput) {
  const { role, concept, search, chat, io, domain, alternate } = input;
  const judge: Judge = input.judge ?? ((i) => judgePage(chat, i));
  const named = alternate ? `${concept} (${alternate})` : concept;
  const kept: Array<Page & { primary: boolean; why: string }> = [];
  const seen = new Set<string>();

  async function gather(query: string) {
    io.credits(1);
    let hits: Hit[] = [];
    try {
      hits = await search.search({ query, maxResults: 4 });
    } catch { /* a failed search finds nothing */ }
    for (const h of hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      const verdict = await judge({ role, concept, page: h, domain });
      if (verdict.keep) kept.push({ ...h, primary: verdict.kind === 'primary', why: verdict.why });
    }
  }

  await gather(`${named} for a ${role}${domain ? ` in ${domain}` : ''}: explanation and best practices`);
  const facts = kept.length ? await extractFacts(chat, { role, concept, pages: kept, domain }) : [];
  let verified = verifyFacts(facts, kept);
  if (verified.dropped.some((d) => d.reason === 'one independent source')) {
    await gather(`${named} ${role}${domain ? ` ${domain}` : ''} definition standard reference`);
    verified = verifyFacts(facts, kept);
  }

  // Resources: pages that are still reachable (primary sources first), and videos; at most four in all, at most two of them videos.
  const nonVideo: ResourceRow[] = [];
  for (const p of [...kept].sort((a, b) => Number(b.primary) - Number(a.primary))) {
    if (nonVideo.length >= MAX_RESOURCES) break;
    if (await input.reachable(p.url)) nonVideo.push({ kind: p.primary ? 'article' : 'blog', title: p.title, source: publisherOf(p.url), url: p.url, why: p.why });
  }
  const found = await findVideos({ youtube: input.youtube, chat, role, concept, now: input.now });
  const videos: ResourceRow[] = found.kept.slice(0, MAX_VIDEOS).map((v) => ({ kind: 'video', title: v.title, source: v.channel, url: v.url, why: v.note }));
  const take = Math.min(videos.length, MAX_VIDEOS);
  const resources = [...nonVideo.slice(0, MAX_RESOURCES - take), ...videos.slice(0, take)];

  return {
    facts: verified.kept as VerifiedFact[],
    droppedFacts: verified.dropped as DroppedFact[],
    groundingPages: [...new Set(verified.kept.flatMap((f) => f.sources))],
    /** The pages that passed the judge, with their text, for the QA agent to check chapters against. */
    pages: kept.map(({ url, title, text }) => ({ url, title, text })),
    resources,
    shortfall: resources.length < MIN_RESOURCES,
    videosRejected: found.rejected,
  };
}

/**
 * A concept that ended under two resources gets one more search (one credit) for pages to read; facts are not taken from it. New pages go after what
 * the concept has, are judged and checked reachable like any other, and the list never passes four. Nothing is searched when it already has two.
 */
export async function topUpResources(input: Pick<ReferenceInput, 'role' | 'concept' | 'search' | 'chat' | 'reachable' | 'io' | 'domain' | 'judge'> & { have: ResourceRow[] }): Promise<ResourceRow[]> {
  const out = [...input.have];
  if (out.length >= MIN_RESOURCES) return out;
  input.io.credits(1);
  let hits: Hit[] = [];
  try {
    hits = await input.search.search({ query: `${input.concept} ${input.role} guide tutorial overview`, maxResults: 4 });
  } catch { /* a failed search adds nothing */ }
  for (const h of hits) {
    if (out.length >= MAX_RESOURCES) break;
    if (out.some((r) => r.url === h.url)) continue;
    const verdict = await (input.judge ?? ((i) => judgePage(input.chat, i)))({ role: input.role, concept: input.concept, page: h, domain: input.domain });
    if (verdict.keep && (await input.reachable(h.url))) out.push({ kind: verdict.kind === 'primary' ? 'article' : 'blog', title: h.title, source: publisherOf(h.url), url: h.url, why: verdict.why });
  }
  return out;
}
