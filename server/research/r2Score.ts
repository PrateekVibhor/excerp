/** R2 scoring: reads out/r2/*.json, prints the result tables as markdown. */
import { readFileSync } from 'node:fs';
import { bestSpan, catchRate, overlaps } from './r2Logic.ts';
import { wilson } from './r1Logic.ts';

const here = new URL('.', import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${here}out/r2/${f}`, 'utf8'));
const chapters = read('chapters.json') as Array<{ id: string; role: string; concept: string; on: string; off: string }>;
const claims = read('claims.json') as Record<string, { on: Array<{ text: string; category: string | null; supported: boolean }>; off: Array<{ text: string; category: string | null; supported: boolean }> }>;
const qa = read('qa.json') as Record<string, Array<{ text: string; verdict: string }>>;
const planted = read('plant-key.json') as Array<{ id: string; chapterId: string; category: string; sentence: string }>;
const variants = read('planted.json') as Array<{ id: string; chapterId: string; text: string }>;
const pct = (k: number, n: number) => { const w = wilson(k, n); return `${k}/${n} = ${(w.rate * 100).toFixed(1)}% (${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}%)`; };
const flagged = (id: string) => (qa[id] ?? []).filter((c) => c.verdict !== 'supported');
const CATS = ['law', 'safety', 'money', 'health'];

const rows: string[] = [];
const cell = (version: 'on' | 'off', useQa: boolean) => {
  let wrong = 0, total = 0;
  const cat: Record<string, number> = {};
  for (const c of chapters) for (const k of claims[c.id]![version]) {
    total++;
    const caught = useQa && flagged(`${version}:${c.id}`).some((f) => overlaps(f.text, k.text, 0.7) || overlaps(k.text, f.text, 0.7));
    if (!k.supported && !caught) { wrong++; if (k.category) cat[k.category] = (cat[k.category] ?? 0) + 1; }
  }
  return { wrong, total, cat };
};
for (const [name, version, useQa] of [['no safeguard (written from memory)', 'off', false], ['grounding (written only from sources)', 'on', false], ['QA agent only (memory + QA)', 'off', true], ['both (grounding + QA)', 'on', true]] as const) {
  const r = cell(version, useQa);
  rows.push(`| ${name} | ${pct(r.wrong, r.total)} | ${CATS.map((c) => r.cat[c] ?? 0).join(' / ')} |`);
}

const flags = variants.flatMap((v) => flagged(`planted:${v.id}`).map((f) => ({ chapter: v.id, text: f.text })));
const rate = catchRate(planted.map((p) => ({ id: p.id, category: p.category, sentence: p.sentence, chapter: p.id })), flags);
const catchRows = CATS.map((c) => `| ${c} | ${pct(rate.byCategory[c]!.caught, rate.byCategory[c]!.total)} |`);
const plantedUnsupported = planted.filter((p) => !bestSpan(p.sentence, chapters.find((c) => c.id === p.chapterId)!.on ? sourceOf(p.chapterId) : '').supported).length;
function sourceOf(chapterId: string) {
  const c = chapters.find((x) => x.id === chapterId)!;
  const file = JSON.parse(readFileSync(`${here}out/r2/sources-${c.role.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`, 'utf8')) as Record<string, Array<{ text: string }>>;
  return (file[c.concept] ?? []).map((p) => p.text).join('\n');
}

let onFlagged = 0, onTotal = 0, onWrongFlag = 0, qaOnClaims = 0;
for (const c of chapters) {
  const list = qa[`on:${c.id}`] ?? [];
  qaOnClaims += list.length;
  for (const f of flagged(`on:${c.id}`)) { onFlagged++; if (bestSpan(f.text, sourceOf(c.id)).supported) onWrongFlag++; }
  onTotal += claims[c.id]!.on.length;
}
const catClaims = (v: 'on' | 'off') => CATS.map((c) => chapters.reduce((s, ch) => s + claims[ch.id]![v].filter((k) => k.category === c).length, 0)).join(' / ');
console.log(`## Numbers
Chapters: ${chapters.length} (written twice). Claims extracted: ${chapters.reduce((s, c) => s + claims[c.id]!.on.length + claims[c.id]!.off.length, 0)} (grounded ${onTotal}, from memory ${chapters.reduce((s, c) => s + claims[c.id]!.off.length, 0)}). Claims by category law/safety/money/health: grounded ${catClaims('on')}; memory ${catClaims('off')}.

### Claims with no matching span in the sources ("unsupported" by span matching)
| safeguards | unsupported share of claims (Wilson 95%) | unsupported law / safety / money / health |
|---|---|---|
${rows.join('\n')}

### QA agent: planted false claims caught (${planted.length} planted, ${rate.overall.total} checked)
| category | caught (Wilson 95%) |
|---|---|
${catchRows.join('\n')}
| overall | ${pct(rate.overall.caught, rate.overall.total)} |

Planted sentences with no matching span in their sources: ${plantedUnsupported}/${planted.length}.

### QA agent on clean grounded chapters
It listed ${qaOnClaims} claims and flagged ${onFlagged} as unsupported or contradicted. Of those flags, ${onWrongFlag} are claims that span matching finds in the sources (flagged although the source states them): ${pct(onWrongFlag, onFlagged || 1)}.`);
