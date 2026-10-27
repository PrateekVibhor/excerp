/**
 * YouTube feasibility spike, step 1 (plan 16, phase 3): find candidate videos for 9 role/concept pairs with the YouTube Data API v3 (about
 * 900 of the free 10,000 daily quota units), screen them with videoLogic.ts, and write the owner's keep/reject sheet.
 *   node --env-file=.env research/videoSearch.ts
 * The key is read from YOUTUBE_API_KEY and never printed or written.
 */
import { writeFileSync } from 'node:fs';
import { screenVideo, type VideoMeta } from './videoLogic.ts';

const here = new URL('.', import.meta.url).pathname;
const key = process.env.YOUTUBE_API_KEY?.trim();
if (!key) throw new Error('YOUTUBE_API_KEY is not set');
const PAIRS: Array<[string, string]> = [
  ['backend software engineer', 'debugging'], ['backend software engineer', 'observability and monitoring'], ['backend software engineer', 'microservices'],
  ['ML engineer', 'model evaluation'], ['ML engineer', 'data pipeline development'], ['ML engineer', 'large language models'],
  ['forward-deployed engineer', 'stakeholder engagement'], ['forward-deployed engineer', 'architecture design'], ['forward-deployed engineer', 'problem solving'],
];

async function api<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: key! })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube ${path} answered HTTP ${res.status}`); // the URL holds the key, so it is not repeated
  return (await res.json()) as T;
}

const now = new Date();
const rows: Array<VideoMeta & { role: string; concept: string; keep: boolean; reasons: string[]; description: string }> = [];
for (const [role, concept] of PAIRS) {
  const found = await api<{ items?: Array<{ id: { videoId: string } }> }>('search', { part: 'snippet', type: 'video', q: `${concept} ${role} real world experience`, videoCaption: 'closedCaption', relevanceLanguage: 'en', maxResults: '10' });
  const ids = (found.items ?? []).map((i) => i.id.videoId);
  if (!ids.length) continue;
  const details = await api<{ items?: Array<{ id: string; snippet: { title: string; channelTitle: string; channelId: string; publishedAt: string; description: string; defaultAudioLanguage?: string; defaultLanguage?: string }; contentDetails: { duration: string; caption: string }; statistics: { viewCount?: string; likeCount?: string } }> }>('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') });
  for (const d of details.items ?? []) {
    const meta: VideoMeta = { id: d.id, title: d.snippet.title, channel: d.snippet.channelTitle, channelId: d.snippet.channelId, publishedAt: d.snippet.publishedAt, duration: d.contentDetails.duration, views: Number(d.statistics.viewCount ?? 0), likes: Number(d.statistics.likeCount ?? 0), captions: d.contentDetails.caption === 'true', language: d.snippet.defaultAudioLanguage ?? d.snippet.defaultLanguage };
    rows.push({ ...meta, role, concept, ...screenVideo(meta, now), description: d.snippet.description.slice(0, 300) });
  }
  console.log(role, '/', concept, ids.length, 'found');
}
writeFileSync(`${here}out/video/candidates.json`, `${JSON.stringify(rows, null, 1)}\n`);
const kept = rows.filter((r) => r.keep);
console.log('candidates', rows.length, 'kept by rules', kept.length, '| rejected reasons', JSON.stringify(rows.filter((r) => !r.keep).flatMap((r) => r.reasons).reduce<Record<string, number>>((a, r) => ((a[r] = (a[r] ?? 0) + 1), a), {})));
