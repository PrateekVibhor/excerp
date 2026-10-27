/**
 * Re-applies the current denylist and legitimacy check to saved r0-<role>.json files and drops postings that
 * now fail them (no Tavily credits). Run r0Remerge.ts afterwards to re-rank.
 *   node research/r0Refilter.ts research/out/r0-*.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isLegitimateSource, type SeedEntry } from './r0Logic.ts';

const seed = JSON.parse(readFileSync(new URL('seedCompanies.json', import.meta.url), 'utf8')) as SeedEntry[];
for (const file of process.argv.slice(2)) {
  const out = JSON.parse(readFileSync(file, 'utf8'));
  const kept = out.postings.filter((p: { url: string }) => isLegitimateSource(p.url, seed));
  const removed = out.postings.filter((p: { url: string }) => !isLegitimateSource(p.url, seed));
  if (!removed.length) continue;
  out.postings = kept;
  out.postingsUsed = kept.length;
  out.distinctEmployers = new Set(kept.map((p: { employer: string }) => p.employer)).size;
  out.refiltered = [...(out.refiltered ?? []), ...removed.map((p: { employer: string; url: string }) => ({ employer: p.employer, url: p.url }))];
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(out.role, 'removed', removed.map((p: { employer: string }) => p.employer).join(', '), '->', kept.length, 'postings');
}
