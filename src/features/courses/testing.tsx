// Shared helpers for the tests of the list-course screens: a stand-in for the server's course routes, and sample data.
import type { Changes, CourseApi, CourseResult, ListConcept, ReadyList } from '../../data/courseApi';

export const ok = <T,>(value: T): CourseResult<T> => ({ kind: 'ok', value });
export const refused = (status: number, code: string): CourseResult<never> => ({ kind: 'refused', status, code });

export const OPTIONS = {
  roles: [{ name: 'business analyst', label: 'Business analyst', available: true }, { name: 'product manager', label: 'Product manager', available: false }, { name: 'forward-deployed engineer', label: 'Forward-deployed engineer', available: false }],
  industries: [{ key: 'fintech', label: 'Fintech' }, { key: 'healthcare', label: 'Healthcare' }],
};

export const concept = (n: number, over: Partial<ListConcept> = {}): ListConcept => ({
  id: `k${n}`, name: `concept ${n}`, displayName: `Concept ${n}`, position: n - 1, band: 'strong', tools: [], inYourPosting: false,
  resources: [
    { title: `Library ${n}`, source: 'mode.com', url: `https://mode.com/${n}`, vetted: true },
    { title: `Web ${n}`, source: 'example.org', url: `https://example.org/${n}`, vetted: false },
  ],
  ...over,
});
export const ready = (over: Partial<ReadyList> = {}): ReadyList => ({
  status: 'ready', role: 'data engineer', industry: 'healthcare', industryLabel: 'Healthcare', hasUpdates: false, seenVersion: 0, evidence: null,
  coverage: { total: 3, strong: 1, thin: 1, missing: 1 },
  concepts: [
    concept(1),
    concept(2, { band: 'thin', resources: [{ title: 'FHIR overview', source: 'hl7.org', url: 'https://hl7.org/fhir', vetted: true }] }),
    concept(3, { band: 'missing', resources: [{ title: 'HHS guidance', source: 'hhs.gov', url: 'https://hhs.gov/x', vetted: false }] }),
  ],
  ...over,
});
export const rise: Changes = {
  currentVersion: 3,
  changes: [{ id: 'a', version: 3, kind: 'coverage_improved', target: 'k2', summary: 'Concept 2: now thin, with 1 vetted source (was missing)', publishedAt: '2026-10-13T09:00:00.000Z' }],
};

/** A server stand-in whose every call is a jest mock with a sensible default answer; override any of them. */
export function fakeCourses(over: Partial<{ [K in keyof CourseApi]: jest.Mock }> = {}): CourseApi & { [K in keyof CourseApi]: jest.Mock } {
  return {
    options: jest.fn(async () => ok(OPTIONS)),
    start: jest.fn(async () => ok({ courseId: 'c1', status: 'finding_sources', existing: false })),
    approve: jest.fn(async () => ok({ courseId: 'c1', status: 'building' })),
    cancel: jest.fn(async () => ok({ courseId: 'c1', status: 'cancelled' })),
    home: jest.fn(async () => ok(ready())),
    mine: jest.fn(async () => ok([])),
    open: jest.fn(async () => ok(null)),
    rename: jest.fn(async () => ok(null)),
    remove: jest.fn(async () => ok(null)),
    refresh: jest.fn(async () => ok({ status: 'up_to_date' as const, repeat: false })),
    changes: jest.fn(async () => ok({ currentVersion: 0, changes: [] })),
    seen: jest.fn(async () => ok(null)),
    ...over,
  } as CourseApi & { [K in keyof CourseApi]: jest.Mock };
}
