/** YouTube spike, step 2: the owner's blind keep/reject sheet (the 18 rule-kept videos plus 12 rule-rejected ones, shuffled) and a hidden key. */
import { readFileSync, writeFileSync } from 'node:fs';
import { durationSeconds, type VideoMeta } from './videoLogic.ts';

const here = new URL('.', import.meta.url).pathname;
type Row = VideoMeta & { role: string; concept: string; keep: boolean; reasons: string[]; description: string };
const rows = JSON.parse(readFileSync(`${here}out/video/candidates.json`, 'utf8')) as Row[];
let seed = 5;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = <T>(xs: T[]) => { const o = [...xs]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; } return o; };
// rejected videos worth testing: those that failed only on age, views, like ratio or length (not obvious junk), a few of each
const rejected = shuffle(rows.filter((r) => !r.keep && r.reasons.every((x) => x !== 'not English' && x !== 'clickbait title'))).slice(0, 12);
const picked = shuffle([...rows.filter((r) => r.keep), ...rejected]).map((r, i) => ({ ...r, n: i + 1 }));
const mins = (iso: string) => `${Math.round(durationSeconds(iso) / 60)} min`;
writeFileSync(`${here}out/video/keep-reject.md`, [
  '# YouTube spike: which of these videos would you trust to explain the skill?', '',
  `${picked.length} videos found by searching for a skill in a role. For each, open the link if you like and judge from the title, channel and what you see: would you want a reader of a course on this skill to be pointed to it, as a practitioner explaining the skill in depth?`,
  'Write after "label:" exactly one of: keep (credible practitioner or genuinely good explanation), reject (clickbait, shallow, an ad, a course sales pitch, or off topic), unsure.', '',
  ...picked.flatMap((r) => [`${r.n}. [${r.role}: ${r.concept}] "${r.title}" by ${r.channel} · ${mins(r.duration)} · ${r.views.toLocaleString('en-US')} views · ${r.publishedAt.slice(0, 7)}`, `   https://www.youtube.com/watch?v=${r.id}`, `   ${r.description.replace(/\s+/g, ' ').slice(0, 220)}`, '   label:', '']),
].join('\n'));
writeFileSync(`${here}out/video/keep-reject-key.json`, `${JSON.stringify(picked.map(({ n, id, role, concept, keep, reasons }) => ({ n, id, role, concept, ruleKeep: keep, reasons })), null, 1)}\n`);
console.log('sheet', picked.length, 'videos;', picked.filter((p) => p.keep).length, 'rule-kept,', picked.filter((p) => !p.keep).length, 'rule-rejected');
console.log('kept by pair', JSON.stringify(rows.filter((r) => r.keep).reduce<Record<string, number>>((a, r) => ((a[r.role + '/' + r.concept] = (a[r.role + '/' + r.concept] ?? 0) + 1), a), {})));
