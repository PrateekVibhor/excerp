// Plan 16, part 3, step B: the reference library loader (server/reference-library/, sdlc/reference-library-proposal.md). It reads the shared file and each
// role's folder, and checks them against the entry schema, so a bad library fails here and not in a build. Files only: nothing here is network or model.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LibrarySource {
  id: string;
  name: string;
  url: string;
  layer: 'institutional' | 'practical' | 'ai-native';
  tier: 1 | 2 | 3;
  access: 'open' | 'free_account';
  perspective: 'canonical' | 'field';
  pipeline_readable: boolean;
  applies_to: string[];
  rationale: string;
  licence: string;
  free_parts: string;
  last_verified: { date: string; text_verified?: boolean; access_confirmed?: boolean; [k: string]: unknown };
  next_check: string;
  status: string;
  citation_policy?: string;
  decision_note?: string;
  access_confirmed?: boolean;
  [k: string]: unknown;
}
export interface RoleFile {
  role: string;
  built: string;
  sources: LibrarySource[];
  uses_shared: string[];
  checked_and_excluded: Array<{ name?: string; reason?: string; date?: string; [k: string]: unknown }>;
}
export interface Library {
  shared: LibrarySource[];
  roles: Record<string, RoleFile>;
}
export interface Issue { where: string; message: string }

const readJson = (file: string, label: string): any => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
};

export function loadLibrary(dir: string): Library {
  const shared = readJson(join(dir, 'shared.json'), 'shared.json').sources as LibrarySource[];
  const roles: Record<string, RoleFile> = {};
  for (const name of readdirSync(dir).sort()) {
    if (!statSync(join(dir, name)).isDirectory()) continue;
    const file = join(dir, name, 'sources.json');
    try {
      statSync(file);
    } catch {
      continue;
    }
    const raw = readJson(file, `${name}/sources.json`);
    roles[name] = { role: raw.role ?? name, built: raw.built ?? '', sources: raw.sources ?? [], uses_shared: raw.uses_shared ?? [], checked_and_excluded: raw.checked_and_excluded ?? [] };
  }
  return { shared: shared ?? [], roles };
}

const LAYERS = ['institutional', 'practical', 'ai-native'];
const ACCESS = ['open', 'free_account'];
const PERSPECTIVES = ['canonical', 'field'];
const STATUSES = ['active', 'candidate_other_roles', 'suspended', 'removed', 'flagged'];
const REQUIRED = ['id', 'name', 'url', 'layer', 'tier', 'access', 'perspective', 'pipeline_readable', 'applies_to', 'rationale', 'licence', 'free_parts', 'last_verified', 'next_check', 'status'];
const DAY = 86_400_000;

const validDate = (d: unknown): d is string => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; // 2026-02-30 rolls over to March: not a date
};
/** Reuse terms stated in the source's own words (or its licence), as opposed to a bare copyright line. */
const EXPLICIT_GRANT = /CC BY|Creative Commons|Permission is granted|You may quote|License to use/i;
const NO_TERMS = /not verified|from knowledge|all rights reserved|no reuse terms|no copyright|no content licen/i;

export function validateLibrary(lib: Library, opts: { today?: Date } = {}): { errors: Issue[]; warnings: Issue[] } {
  const today = opts.today ?? new Date();
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (where: string, message: string) => void errors.push({ where, message });
  const warn = (where: string, message: string) => void warnings.push({ where, message });
  const seen = new Set<string>();

  const entry = (s: LibrarySource) => {
    const where = typeof s.id === 'string' && s.id ? s.id : '(no id)';
    for (const f of REQUIRED) if (s[f] === undefined || s[f] === null || s[f] === '') err(where, `missing ${f}`);
    if (typeof s.id === 'string' && s.id) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) err(where, 'id must be lower-case words joined by hyphens');
      if (seen.has(s.id)) err(where, `duplicate id "${s.id}"`);
      seen.add(s.id);
    }
    if (s.layer !== undefined && !LAYERS.includes(s.layer)) err(where, `layer must be one of ${LAYERS.join(', ')}`);
    if (s.tier !== undefined && ![1, 2, 3].includes(s.tier as number)) err(where, 'tier must be 1, 2 or 3');
    if (s.access !== undefined && !ACCESS.includes(s.access)) err(where, `access must be one of ${ACCESS.join(', ')} (anything else is not listed)`);
    if (s.perspective !== undefined && !PERSPECTIVES.includes(s.perspective)) err(where, `perspective must be one of ${PERSPECTIVES.join(', ')}`);
    if (s.status !== undefined && !STATUSES.includes(s.status)) err(where, `status must be one of ${STATUSES.join(', ')}`);
    if (typeof s.url === 'string') {
      try {
        if (!['http:', 'https:'].includes(new URL(s.url).protocol)) err(where, 'url must be an http or https address');
      } catch {
        err(where, 'url must be an http or https address');
      }
    }
    if (s.applies_to !== undefined && (!Array.isArray(s.applies_to) || s.applies_to.length === 0)) err(where, 'applies_to must list at least one role');
    if (s.next_check !== undefined && !validDate(s.next_check)) err(where, 'next_check is not a valid date (YYYY-MM-DD)');
    if (s.last_verified && typeof s.last_verified === 'object' && !validDate(s.last_verified.date)) err(where, 'last_verified.date is not a valid date (YYYY-MM-DD)');
    if (s.access === 'open' && s.pipeline_readable === false) err(where, 'an open source must be pipeline_readable');
    if (s.access === 'free_account' && s.pipeline_readable === true) err(where, 'a free_account source must not be pipeline_readable (it is cited, never fetched)');
    if (s.citation_policy && !s.decision_note) err(where, 'citation_policy needs a decision_note recording the decision');

    if (s.last_verified?.text_verified === false) warn(where, 'its text was not read, so quotability is unconfirmed');
    if (s.access_confirmed === false || s.last_verified?.access_confirmed === false) warn(where, 'access class not confirmed by opening a lesson or the file');
    if (validDate(s.next_check) && new Date(`${s.next_check}T00:00:00Z`) < today) warn(where, `next check is overdue (${s.next_check})`);
    if (validDate(s.last_verified?.date) && today.getTime() - new Date(`${s.last_verified.date}T00:00:00Z`).getTime() > 60 * DAY) warn(where, 'last verified more than 60 days ago');
    if (s.status && s.status !== 'active') warn(where, `not active (status ${s.status})`);
    const licence = String(s.licence ?? '');
    if (!s.citation_policy && !EXPLICIT_GRANT.test(licence) && NO_TERMS.test(licence)) warn(where, 'no stated reuse terms and no citation_policy/decision_note recording the attributed-citation decision');
  };

  for (const s of lib.shared) entry(s);
  const sharedById = new Map(lib.shared.map((s) => [s.id, s]));
  for (const [slug, file] of Object.entries(lib.roles)) {
    for (const s of file.sources) {
      entry(s);
      if (Array.isArray(s.applies_to) && !s.applies_to.includes(slug)) err(s.id, `${s.id} does not list ${slug} in applies_to`);
    }
    for (const id of file.uses_shared) {
      const shared = sharedById.get(id);
      if (!shared) err(slug, `uses_shared "${id}" is not in shared.json`);
      else if (!shared.applies_to?.includes(slug)) err(slug, `uses_shared "${id}" does not list ${slug} in applies_to`);
    }
    for (const x of file.checked_and_excluded) {
      if (!x.name) err(slug, 'a checked_and_excluded item has no name');
      else if (!x.reason) err(slug, `checked_and_excluded "${x.name}" has no reason`);
      if (x.name && !validDate(x.date)) err(slug, `checked_and_excluded "${x.name}" has no valid date`);
    }
  }
  return { errors, warnings };
}

/** What a role may ground a course on: its own sources and the shared ones it uses, active only, each marked own or shared. */
export function sourcesFor(lib: Library, slug: string): Array<LibrarySource & { own: boolean }> {
  const file = lib.roles[slug];
  if (!file) return [];
  const shared = new Map(lib.shared.map((s) => [s.id, s]));
  return [
    ...file.sources.map((s) => ({ ...s, own: true })),
    ...file.uses_shared.flatMap((id) => (shared.has(id) ? [{ ...shared.get(id)!, own: false }] : [])),
  ].filter((s) => s.status === 'active');
}
