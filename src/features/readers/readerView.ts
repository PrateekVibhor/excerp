import { initialsOf } from '../profile/ProfileSummary';

export interface ListReader {
  /** The reader's public id. */
  id: string;
  name: string;
  industry: string;
  /** A line to show instead of the industry, for instance "Software · Verified it". */
  detail?: string;
  avatar: { initials: string; tone: 0 | 1 | 2 };
}

/** One of the three avatar colors, chosen from the public id so the same reader always has the same one. */
export function toneOf(publicId: string): 0 | 1 | 2 {
  let hash = 0;
  for (const ch of publicId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % 3) as 0 | 1 | 2;
}

export const avatarOf = (name: string, publicId: string) => ({ initials: initialsOf(name) || '?', tone: toneOf(publicId) });

export const toListReader = (r: { public_id: string; display_name: string; industry: string }): ListReader => ({
  id: r.public_id,
  name: r.display_name,
  industry: r.industry,
  avatar: avatarOf(r.display_name, r.public_id),
});
