// Plan 16, part 3, step B: the dry-run coverage report as a document. Numbers in, markdown out.
import type { Coverage, ConceptIn } from './match.ts';

export interface CourseReport {
  role: string;
  courseId: string;
  status: string;
  /** The library folder for the role, or null when the library has none. */
  slug: string | null;
  concepts: ConceptIn[];
  sourcesRead: number;
  sourcesSkipped: Array<{ id: string; reason: string }>;
  coverage: Coverage | null;
}
export interface ReportInput {
  date: string;
  library: { errors: number; warnings: number };
  courses: CourseReport[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderReport(input: ReportInput): string {
  const out: string[] = [
    '# Reference library: dry-run coverage',
    '',
    `Run ${input.date}. Nothing was spent and nothing in the pipeline or the database was changed: the library files were read, each readable source was fetched once and its text held in memory for this run only, and the concept lists were read from the saved courses.`,
    '',
    `Library check: ${input.library.errors} errors, ${input.library.warnings} warnings.`,
    '',
    '**How to read this.** A concept is "mentioned" when the library text contains its name or one of its other names (a skill) or most of its key words close together (a scenario). Mentioned is not usable: a mention can be in the wrong context, can say nothing a fact could be drawn from, and a fact still has to pass the verification rules. The match is by words only, with no model, so it is a floor on what a model-based match would find.',
    '',
  ];
  for (const c of input.courses) {
    out.push(`## ${c.role} (${c.status}, course ${c.courseId.slice(0, 8)})`, '');
    if (!c.slug || !c.coverage) {
      out.push(`No library folder for this role, so nothing to measure (${c.concepts.length} concepts).`, '');
      continue;
    }
    const s = c.coverage.summary;
    out.push(
      `- ${s.strong + s.single} of ${s.total} concepts mentioned (strong, in two or more sources: ${s.strong}; in one source: ${s.single}; in none: ${s.none}).`,
      `- ${pct(s.weightedMentioned)} of the postings' mentions are for concepts the library mentions.`,
      `- Sources read: ${c.sourcesRead}; not read: ${c.sourcesSkipped.length}.`,
      '',
    );
    const missing = c.coverage.rows.filter((r) => r.band === 'none').sort((a, b) => b.concept.mentions - a.concept.mentions);
    if (missing.length) out.push('Not mentioned by any source (most asked-for first):', ...missing.map((r) => `- ${r.concept.name} (${r.concept.kind}, ${r.concept.mentions} postings)`), '');
    const top = c.coverage.perSource.filter((p) => p.concepts > 0).slice(0, 8);
    if (top.length) out.push('Sources that mention the most concepts:', ...top.map((p) => `- ${p.id}: ${p.concepts}`), '');
    if (s.sourcesWithNone.length) out.push('Sources that mention none of this course\'s concepts:', ...s.sourcesWithNone.map((id) => `- ${id}`), '');
    if (c.sourcesSkipped.length) out.push('Sources not read:', ...c.sourcesSkipped.map((x) => `- ${x.id}: ${x.reason}`), '');
  }
  return `${out.join('\n')}\n`;
}
