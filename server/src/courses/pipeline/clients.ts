// Plan 16, phase 4: the real clients behind the interfaces the pipeline takes. Each takes its key and a fetch, so tests use a fake fetch and
// nothing here prints or returns a key. An error names the HTTP status only.
import type { Hit, SearchClient, SearchParams } from './postings.ts';
import type { YoutubeClient } from './video.ts';
import type { VideoMeta } from './videoScreen.ts';

/** Page text for urls, one Tavily extract call (about a credit per five pages). */
export interface ExtractClient {
  extract(urls: string[]): Promise<Record<string, string>>;
}

export function createTavily(apiKey: string, fetcher: typeof fetch = fetch): SearchClient & ExtractClient {
  async function post(path: 'search' | 'extract', body: object): Promise<any> {
    const res = await fetcher(`https://api.tavily.com/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Tavily ${path} answered HTTP ${res.status}`);
    return res.json();
  }
  return {
    async search(p: SearchParams): Promise<Hit[]> {
      const json = await post('search', {
        query: p.query, search_depth: 'basic', topic: 'general', max_results: p.maxResults, include_raw_content: 'text', include_answer: false,
        ...(p.includeDomains ? { include_domains: p.includeDomains } : {}), ...(p.excludeDomains ? { exclude_domains: p.excludeDomains } : {}),
      });
      return (json.results ?? []).map((r: any) => ({ url: String(r.url ?? ''), title: String(r.title ?? ''), text: String(r.raw_content ?? r.content ?? '') }));
    },
    async extract(urls: string[]): Promise<Record<string, string>> {
      const json = await post('extract', { urls, extract_depth: 'basic' });
      return Object.fromEntries((json.results ?? []).filter((r: any) => r.raw_content).map((r: any) => [String(r.url), String(r.raw_content)]));
    },
  };
}

const toSeconds = (t: string) => t.split(':').reduce((s, p) => s * 60 + Number(p), 0);

/** Chapter markers: lines of a description that start with a time (m:ss or h:mm:ss) followed by a title. */
export function parseChapters(description: string): Array<{ at: number; title: string }> {
  return description
    .split('\n')
    .map((l) => /^\s*(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ at: toSeconds(m[1]!), title: m[2]!.trim() }));
}

export function createYoutube(apiKey: string, fetcher: typeof fetch = fetch): YoutubeClient {
  async function get(path: string, params: Record<string, string>): Promise<any> {
    const res = await fetcher(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: apiKey })}`);
    if (!res.ok) throw new Error(`YouTube ${path} answered HTTP ${res.status}`); // the url holds the key, so it is not repeated
    return res.json();
  }
  return {
    async search(query: string): Promise<string[]> {
      const json = await get('search', { part: 'snippet', type: 'video', q: query, videoCaption: 'closedCaption', relevanceLanguage: 'en', maxResults: '10' });
      return (json.items ?? []).map((i: any) => String(i.id?.videoId)).filter(Boolean);
    },
    async videos(ids: string[]): Promise<VideoMeta[]> {
      const json = await get('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') });
      return (json.items ?? []).map((d: any): VideoMeta => ({
        id: d.id, title: d.snippet.title, channel: d.snippet.channelTitle, channelId: d.snippet.channelId, publishedAt: d.snippet.publishedAt, duration: d.contentDetails.duration,
        views: Number(d.statistics?.viewCount ?? 0), likes: Number(d.statistics?.likeCount ?? 0), captions: d.contentDetails.caption === 'true',
        language: d.snippet.defaultAudioLanguage ?? d.snippet.defaultLanguage, description: String(d.snippet.description ?? ''), chapters: parseChapters(String(d.snippet.description ?? '')),
      }));
    },
  };
}
