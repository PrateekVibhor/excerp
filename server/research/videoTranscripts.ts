/**
 * YouTube spike, step 3: can transcripts be fetched at all? One-off test from this Mac for the rule-kept videos, using the public caption
 * track a browser would use (not the official API, which cannot read other people's captions). Research only; not wired into anything.
 * Transcripts are written to out/video/transcripts/ (not for committing). Sequential, with a pause between videos.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { VideoMeta } from './videoLogic.ts';

const here = new URL('.', import.meta.url).pathname;
const rows = (JSON.parse(readFileSync(`${here}out/video/candidates.json`, 'utf8')) as Array<VideoMeta & { keep: boolean }>).filter((r) => r.keep);
mkdirSync(`${here}out/video/transcripts`, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ id: string; title: string; ok: boolean; kind?: string; words?: number; why?: string }> = [];

for (const v of rows) {
  try {
    const page = await (await fetch(`https://www.youtube.com/watch?v=${v.id}`, { headers: { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' } })).text();
    const m = /"captionTracks":(\[.*?\])/.exec(page);
    if (!m) { results.push({ id: v.id, title: v.title, ok: false, why: 'no caption tracks in the page' }); continue; }
    const tracks = JSON.parse(m[1]!) as Array<{ baseUrl: string; languageCode: string; kind?: string }>;
    const track = tracks.find((t) => t.languageCode.startsWith('en') && t.kind !== 'asr') ?? tracks.find((t) => t.languageCode.startsWith('en'));
    if (!track) { results.push({ id: v.id, title: v.title, ok: false, why: 'no English track' }); continue; }
    const res = await fetch(`${track.baseUrl}&fmt=json3`);
    const body = await res.text();
    if (!res.ok || !body) { results.push({ id: v.id, title: v.title, ok: false, why: `caption fetch HTTP ${res.status}, ${body.length} bytes` }); continue; }
    const events = (JSON.parse(body) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8: string }> }> }).events ?? [];
    const lines = events.filter((e) => e.segs).map((e) => `[${Math.floor((e.tStartMs ?? 0) / 1000)}s] ${e.segs!.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim()}`).filter((l) => l.length > 8);
    writeFileSync(`${here}out/video/transcripts/${v.id}.txt`, lines.join('\n'));
    results.push({ id: v.id, title: v.title, ok: true, kind: track.kind === 'asr' ? 'auto-generated' : 'manual', words: lines.join(' ').split(/\s+/).length });
  } catch (e) {
    results.push({ id: v.id, title: v.title, ok: false, why: (e as Error).message.slice(0, 80) });
  }
  await sleep(2500);
}
writeFileSync(`${here}out/video/transcript-results.json`, `${JSON.stringify(results, null, 1)}\n`);
console.log('fetched', results.filter((r) => r.ok).length, 'of', results.length, '| manual', results.filter((r) => r.kind === 'manual').length, 'auto', results.filter((r) => r.kind === 'auto-generated').length);
console.log('failures', JSON.stringify(results.filter((r) => !r.ok).map((r) => r.why).reduce<Record<string, number>>((a, w) => ((a[w!] = (a[w!] ?? 0) + 1), a), {})));
