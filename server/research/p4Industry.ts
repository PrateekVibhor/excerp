// The industry option of p4Run.ts's `find`, kept apart from the script so it can be tested (the script runs on import). The check is the API's own:
// the same list of keys (src/courses/industries.ts), so what the API would refuse is refused here before anything is queried or any credit spent.
import { industryPhrase, isIndustryKey } from '../src/courses/industries.ts';

export type FindArgs = { ok: true; role: string; industry: string } | { ok: false; error: string };

/** `find "<role>" [--industry <key> | --industry=<key>]`. An empty industry means none was chosen, as in the API. */
export function parseFindArgs(args: string[]): FindArgs {
  let role: string | undefined;
  let industry = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--industry' || a.startsWith('--industry=')) {
      const value = a === '--industry' ? args[++i] : a.slice('--industry='.length);
      if (value === undefined) return { ok: false, error: 'industry_invalid' };
      if (value !== '' && !isIndustryKey(value)) return { ok: false, error: 'industry_invalid' };
      industry = value;
    } else if (a.startsWith('--')) return { ok: false, error: `unknown_flag ${a.split('=')[0]}` };
    else if (role !== undefined) return { ok: false, error: 'one_role_only' };
    else role = a;
  }
  return role === undefined || role.trim() === '' ? { ok: false, error: 'role_required' } : { ok: true, role, industry };
}

/** The insert for a course that is finding sources. The industry column is named only when one was chosen, so a database from before industries still works without it. */
export function courseInsert(roleId: string, title: string, requesterId: string, industry: string): { text: string; values: string[] } {
  return industry
    ? { text: `INSERT INTO courses (role_id, title, status, requested_by, industry) VALUES ($1, $2, 'finding_sources', $3, $4) RETURNING id`, values: [roleId, title, requesterId, industry] }
    : { text: `INSERT INTO courses (role_id, title, status, requested_by) VALUES ($1, $2, 'finding_sources', $3) RETURNING id`, values: [roleId, title, requesterId] };
}

export function describeIndustry(key: string): string {
  if (key === '') return 'industry: none chosen (the pipeline will guess one)';
  const phrase = industryPhrase(key);
  return phrase ? `industry: ${key} (research phrase "${phrase}")` : `industry: ${key} (not in the current list; the pipeline will guess one)`;
}

/** Library-first research for a headless build: off unless P4_LIBRARY is exactly 1, then the reference library folder next to this script's directory. */
export function libraryOption(env: Record<string, string | undefined>, researchDir: string): { dir: string } | undefined {
  return env.P4_LIBRARY === '1' ? { dir: `${researchDir}../reference-library` } : undefined;
}

