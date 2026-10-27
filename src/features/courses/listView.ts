/** What the list-course screens show, worked out from what the server sends. No screen logic lives in the components. */
import type { Band, CourseChange, ListEvidence, Meter, Resource } from '../../data/courseApi';

/** The parts of the coverage bar, in order, each with its share of the concepts; a part with none is left out. */
export function meterParts(m: Meter): Array<[Band, number]> {
  return ([['strong', m.strong], ['thin', m.thin], ['missing', m.missing]] as Array<[Band, number]>).filter(([, n]) => n > 0);
}

export interface Rise { id: string; name: string; from: Band; to: Band; sources: number }
const ORDER: Record<Band, number> = { missing: 0, thin: 1, strong: 2 };
const SUMMARY = /^(.+): now (strong|thin|missing), with (\d+) vetted sources? \(was (strong|thin|missing)\)$/;

/** The coverage rises among the changes (the only kind a reader is told about), read from the server's summary line. Anything else is left out. */
export function whatsNew(changes: CourseChange[]): Rise[] {
  const out: Rise[] = [];
  for (const c of changes) {
    if (c.kind !== 'coverage_improved') continue;
    const m = SUMMARY.exec(c.summary);
    if (!m) continue;
    const [, name, to, sources, from] = m as unknown as [string, string, Band, string, Band];
    if (ORDER[to] > ORDER[from]) out.push({ id: c.id, name, from, to, sources: Number(sources) });
  }
  return out;
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/** "WHAT'S NEW SINCE TUESDAY": the weekday of the change. */
export const sinceLabel = (isoDate: string): string => `WHAT'S NEW SINCE ${DAYS[new Date(isoDate).getDay()]}`;
/** The highest version among the changes: what to mark as seen once the card is dismissed. */
export const newest = (changes: CourseChange[]): number => changes.reduce((n, c) => Math.max(n, c.version), 0);

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
/** A library source: its host under "Library". A web link: just "web". */
export function resourceRow(r: Resource): { title: string; label: string; vetted: boolean } {
  return { title: r.title, label: r.vetted ? `Library · ${host(r.url) || r.source}` : 'web', vetted: r.vetted };
}

export type StepState = 'done' | 'active' | 'waiting';
const STEPS: Array<{ label: string; stages: string[] }> = [
  { label: 'Reading the job posting', stages: ['', 'queued', 'read'] },
  { label: 'Listing concepts in order', stages: ['rank', 'delta'] },
  { label: 'Matching library sources', stages: ['reference', 'sequence'] },
  { label: 'Rating coverage', stages: ['list', 'publish'] },
];
/** The four steps shown while a course builds, from the stage the server reports (none yet means the first). */
export function buildSteps(stage: string): Array<{ label: string; state: StepState }> {
  const at = Math.max(0, STEPS.findIndex((s) => s.stages.includes(stage)));
  return STEPS.map((s, i) => ({ label: s.label, state: i < at ? 'done' : i === at ? 'active' : 'waiting' }));
}

/** The line under a concept's links that says what its rating means. Strong needs none. */
export function bandNote(band: Band, resources: Resource[]): string | null {
  if (band === 'missing') return "No library source yet. We'll let you know on this screen when one is added.";
  if (band === 'thin') return resources.some((r) => r.vetted) ? 'Thin means one library source so far. Web links are found automatically and not reviewed.' : 'Only web links so far. They are found automatically and not reviewed.';
  return null;
}

/** The earliest date among the changes (when the news the reader has not seen began). */
export const oldestDate = (changes: CourseChange[]): string => changes.map((c) => c.publishedAt).sort()[0] ?? '';

/** "Built from your posting and 3 similar postings": only for a list built from fewer than eight, so the reader knows the evidence is thin. */
export function evidenceNote(e: ListEvidence | null): string | null {
  if (!e || !e.thin) return null;
  const n = e.similarPostings;
  const similar = `${n} similar posting${n === 1 ? '' : 's'}`;
  if (e.ownPosting) return n === 0 ? 'Built from your posting' : `Built from your posting and ${similar}`;
  return n === 0 ? null : `Built from ${similar}`;
}
