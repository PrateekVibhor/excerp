/** Video screening for the YouTube feasibility spike (plan 16, phase 3). Pure rules over metadata from the YouTube Data API. */

export interface VideoMeta {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  publishedAt: string;
  /** ISO 8601, as the API gives it (PT24M10S). */
  duration: string;
  views: number;
  likes: number;
  captions: boolean;
  language?: string;
}

export function durationSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

const MIN_SECONDS = 8 * 60;
const MAX_SECONDS = 60 * 60;
const MAX_AGE_DAYS = 4 * 365;
const MIN_VIEWS = 3000;
const MIN_LIKES = 50;

/** Why a video would be passed over; empty reasons mean keep. The title test is crude on purpose: a model judge reads the rest. */
export function screenVideo(v: VideoMeta, now: Date): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const seconds = durationSeconds(v.duration);
  if (seconds < MIN_SECONDS) reasons.push('too short');
  if (seconds > MAX_SECONDS) reasons.push('too long');
  if ((now.getTime() - Date.parse(v.publishedAt)) / 86_400_000 > MAX_AGE_DAYS) reasons.push('too old');
  // raw numbers, each on its own: YouTube's policy bars deriving new metrics from API Data, so no ratio (spec decision 34)
  if (v.views < MIN_VIEWS) reasons.push('too few views');
  if (v.likes < MIN_LIKES) reasons.push('too few likes');
  if (!v.captions) reasons.push('no captions');
  if (v.language && !v.language.toLowerCase().startsWith('en')) reasons.push('not English');
  const letters = v.title.replace(/[^A-Za-z]/g, '');
  if (/you won'?t believe|#shorts|free course|secret trick/i.test(v.title) || (letters.length > 12 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7)) reasons.push('clickbait title');
  return { keep: reasons.length === 0, reasons };
}
