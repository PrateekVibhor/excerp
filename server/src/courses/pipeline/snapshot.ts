// Plan 16, phase 4: the plan and the chapter text of a build, kept in a file as they are produced. A build queued again after a later stage
// failed picks them up instead of asking the model for them again; the file goes once the course is published. Delete it to write afresh.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConceptEvidence } from './rank.ts';
import type { Bible, OutlineSection } from './story.ts';

export interface Snapshot {
  /** The ranked concepts the plan was made for; a resume uses these instead of ranking again, which is model-driven and can differ. */
  concepts?: ConceptEvidence[];
  order: string[];
  story: { bible: Bible; sections: OutlineSection[] };
  /** Chapter text in outline order; shorter than the outline while writing is unfinished. */
  bodies: string[];
  /** True once the coherence pass has run over the bodies. */
  coherent: boolean;
  /** Set once the scope check and the QA agent passed over the bodies; a resume skips both. The audit excerpts are kept by chapter position. */
  checked?: { excerpts: Array<{ index: number; claim: string; category: string; excerpt: string; url: string }> };
}

const file = (dir: string, courseId: string) => join(dir, `${courseId}.json`);
export function saveSnapshot(dir: string, courseId: string, s: Snapshot) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir, courseId), JSON.stringify(s));
}
export function loadSnapshot(dir: string, courseId: string): Snapshot | null {
  return existsSync(file(dir, courseId)) ? (JSON.parse(readFileSync(file(dir, courseId), 'utf8')) as Snapshot) : null;
}
export function clearSnapshot(dir: string, courseId: string) {
  rmSync(file(dir, courseId), { force: true });
}
