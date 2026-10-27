/** The server's routes for list courses (Plan 16): ask for one, approve it, watch it build, read it, and see what changed since the last visit. */

export type Band = 'strong' | 'thin' | 'missing';
export interface Resource { title: string; source: string; url: string; vetted: boolean }
export interface ListConcept { id: string; name: string; displayName: string; position: number; band: Band; resources: Resource[]; tools: string[]; inYourPosting: boolean }
export interface Meter { total: number; strong: number; thin: number; missing: number }
/** What a list was built from, when that was thin: fewer than eight similar postings. */
export interface ListEvidence { thin: boolean; similarPostings: number; ownPosting: boolean }
export interface ReadyList { status: 'ready'; role: string; industry: string | null; industryLabel: string | null; hasUpdates: boolean; seenVersion: number; coverage: Meter; concepts: ListConcept[]; evidence: ListEvidence | null }
/** Anything that is not ready: still being found or built (stage and percent), or failed, cancelled, withdrawn. */
export type NotReadyStatus = 'finding_sources' | 'awaiting_approval' | 'building' | 'failed' | 'cancelled' | 'withdrawn';
const NOT_READY: string[] = ['finding_sources', 'awaiting_approval', 'building', 'failed', 'cancelled', 'withdrawn'];
export interface NotReady { status: NotReadyStatus; role: string; industry: string | null; stage: string; percent: number }
export type ListHome = ReadyList | NotReady;
export interface CourseChange { id: string; version: number; kind: string; target: string | null; summary: string; publishedAt: string }
export interface Changes { currentVersion: number; changes: CourseChange[] }
/** A role the reader can ask for a list for; `available` is false for one that is shown but not offered yet ("coming soon"). */
export interface Options { roles: Array<{ name: string; label: string; available: boolean }>; industries: Array<{ key: string; label: string }> }
/** One of the reader's lists, as the list screen shows it. */
export interface MyList {
  id: string; role: string; status: string; mode: string; visibility: 'shared' | 'private';
  industry: string | null; industryLabel: string | null;
  /** The name the reader gave it; null until they rename it. */
  customTitle: string | null;
  createdAt: string; lastActiveAt: string;
  /** When it was last checked for new sources. */
  checkedAt: string | null;
  /** A check the reader asked for is waiting or running. */
  refreshing: boolean;
  /** The mini coverage count of a ready list. */
  coverage: Meter | null;
  hasUpdates: boolean;
}
export interface RefreshAnswer { status: 'up_to_date' | 'queued'; /** A check was already waiting. */ repeat: boolean }
export interface Started { courseId: string; status: string; existing: boolean }
export interface StartInput { role: string; industry: string; text: string }

/** 'refused' carries the server's status and short code (429 `daily_limit`, 409 `not_enough_postings`, 400 `list_mode_unavailable`); 'failed' is anything else. */
export type CourseResult<T> = { kind: 'ok'; value: T } | { kind: 'refused'; status: number; code: string; /** When to try again, if the server said. */ retryAt?: string } | { kind: 'unauthorized' } | { kind: 'failed'; /** A reply came back but not a usable one (a 5xx, an unreadable body): the server's trouble. Absent when no reply came at all (no network, a timeout): the connection's. */ server?: true };

export interface CourseApi {
  options(): Promise<CourseResult<Options>>;
  start(input: StartInput): Promise<CourseResult<Started>>;
  approve(courseId: string): Promise<CourseResult<{ courseId: string; status: string }>>;
  /** Stops a list that is being found or built. The server answers 200 with the list's id and status, also when it was already stopped; a list that is ready or failed is refused (409 not_cancellable). */
  cancel(courseId: string): Promise<CourseResult<{ courseId: string; status: string }>>;
  home(courseId: string): Promise<CourseResult<ListHome>>;
  /** Every course the reader has joined, most recently used first. */
  mine(): Promise<CourseResult<MyList[]>>;
  /** The reader opened a list: it counts as used now. */
  open(courseId: string): Promise<CourseResult<null>>;
  /** Names a list for the reader; null clears the name. */
  rename(courseId: string, title: string | null): Promise<CourseResult<null>>;
  /** Removes a list from the reader's lists (for a shared list, only theirs). */
  remove(courseId: string): Promise<CourseResult<null>>;
  /** Checks a list for new sources now. */
  refresh(courseId: string): Promise<CourseResult<RefreshAnswer>>;
  changes(courseId: string, since: number): Promise<CourseResult<Changes>>;
  seen(courseId: string, version: number): Promise<CourseResult<null>>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const BANDS = ['strong', 'thin', 'missing'];

function readResource(v: unknown): Resource | null {
  return isObject(v) && str(v.title) && str(v.url) && typeof v.vetted === 'boolean' ? { title: v.title, source: str(v.source) ? v.source : '', url: v.url, vetted: v.vetted } : null;
}
function readConcept(v: unknown): ListConcept | null {
  if (!isObject(v) || !str(v.id) || !str(v.name) || !num(v.position) || !BANDS.includes(v.band as string) || !Array.isArray(v.resources)) return null;
  const resources = v.resources.map(readResource);
  if (resources.some((r) => r === null)) return null;
  return {
    id: v.id, name: v.name, displayName: str(v.display_name) && v.display_name !== '' ? v.display_name : v.name, position: v.position, band: v.band as Band, resources: resources as Resource[],
    tools: Array.isArray(v.tools) ? v.tools.filter(str) : [], inYourPosting: v.in_your_posting === true,
  };
}
function readHome(v: unknown): ListHome | null {
  if (!isObject(v) || !str(v.status) || !str(v.role) || v.mode !== 'list') return null;
  const industry = str(v.industry) && v.industry !== '' ? v.industry : null;
  if (v.status !== 'ready') return NOT_READY.includes(v.status) ? { status: v.status as NotReadyStatus, role: v.role, industry, stage: str(v.stage) ? v.stage : '', percent: num(v.percent) ? v.percent : 0 } : null;
  const c = v.coverage;
  if (!Array.isArray(v.concepts) || !isObject(c) || !num(c.total) || !num(c.strong) || !num(c.thin) || !num(c.missing)) return null;
  const concepts = v.concepts.map(readConcept);
  if (concepts.some((k) => k === null)) return null;
  return {
    status: 'ready', role: v.role, industry, industryLabel: str(v.industry_label) ? v.industry_label : null, hasUpdates: v.has_updates === true, seenVersion: num(v.seen_version) ? v.seen_version : 0, coverage: { total: c.total, strong: c.strong, thin: c.thin, missing: c.missing },
    concepts: (concepts as ListConcept[]).sort((a, b) => a.position - b.position),
    evidence: readEvidence(v.evidence),
  };
}
function readEvidence(v: unknown): ListEvidence | null {
  return isObject(v) && typeof v.thin === 'boolean' && num(v.similar_postings) && typeof v.own_posting === 'boolean' ? { thin: v.thin, similarPostings: v.similar_postings, ownPosting: v.own_posting } : null;
}
function readMine(v: unknown): MyList | null {
  if (!isObject(v) || !str(v.id) || !str(v.role) || !str(v.status) || !str(v.mode) || !str(v.created_at) || !str(v.last_active_at)) return null;
  const c = v.coverage;
  const coverage = isObject(c) && num(c.total) && num(c.strong) && num(c.thin) && num(c.missing) ? { total: c.total, strong: c.strong, thin: c.thin, missing: c.missing } : null;
  return {
    id: v.id, role: v.role, status: v.status, mode: v.mode, visibility: v.visibility === 'private' ? 'private' : 'shared',
    industry: str(v.industry) && v.industry !== '' ? v.industry : null, industryLabel: str(v.industry_label) ? v.industry_label : null,
    customTitle: str(v.custom_title) && v.custom_title !== '' ? v.custom_title : null, createdAt: v.created_at, lastActiveAt: v.last_active_at,
    checkedAt: str(v.checked_at) ? v.checked_at : null, refreshing: v.refreshing === true, coverage, hasUpdates: v.has_updates === true,
  };
}
function readChange(v: unknown): CourseChange | null {
  return isObject(v) && str(v.id) && num(v.version) && str(v.kind) && str(v.summary) && str(v.published_at)
    ? { id: v.id, version: v.version, kind: v.kind, target: str(v.target) ? v.target : null, summary: v.summary, publishedAt: v.published_at }
    : null;
}

/** The server's list-course routes. Anything it cannot be sure of is 'failed'; a refusal keeps the server's code. Tokens are never logged. */
export function createCourseApi(baseUrl: string, getToken: () => Promise<string | null>, fetchFn: Fetch = fetch, timeoutMs = TIMEOUT_MS): CourseApi {
  const root = baseUrl.replace(/\/+$/, '');
  const id = encodeURIComponent;

  async function call<T>(method: string, path: string, body: unknown, parse: (json: unknown) => T | null): Promise<CourseResult<T>> {
    const token = await getToken().catch(() => null);
    if (!token) return { kind: 'unauthorized' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let responded = false;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetchFn(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      responded = true;
      if (res.status === 401) return { kind: 'unauthorized' };
      if ([400, 403, 404, 409, 429].includes(res.status)) {
        let code = '';
        let retryAt: string | undefined;
        try {
          const b: unknown = await res.json();
          if (isObject(b) && str(b.error)) code = b.error;
          if (isObject(b) && str(b.retry_at)) retryAt = b.retry_at;
        } catch {
          // a refusal without a readable reason is still a refusal
        }
        return { kind: 'refused', status: res.status, code, ...(retryAt ? { retryAt } : {}) };
      }
      if (res.status === 204) return { kind: 'ok', value: parse(null) as T };
      if (res.status !== 200 && res.status !== 202) return { kind: 'failed', server: true };
      const value = parse(await res.json());
      return value === null ? { kind: 'failed', server: true } : { kind: 'ok', value };
    } catch {
      return responded ? { kind: 'failed', server: true } : { kind: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  const readStep = (j: unknown) => (isObject(j) && str(j.course_id) && str(j.status) ? { courseId: j.course_id, status: j.status } : null);
  const readStarted = (j: unknown): Started | null => (isObject(j) && str(j.course_id) && str(j.status) ? { courseId: j.course_id, status: j.status, existing: j.existing === true } : null);

  return {
    options: () =>
      call('GET', '/courses/options', undefined, (j) => {
        if (!isObject(j) || !Array.isArray(j.roles) || !Array.isArray(j.industries)) return null;
        const roles = j.roles.filter((r): r is { name: string; label: string; available?: boolean } => isObject(r) && str(r.name) && str(r.label)).map((r) => ({ name: r.name, label: r.label, available: r.available !== false }));
        const industries = j.industries.filter((r): r is { key: string; label: string } => isObject(r) && str(r.key) && str(r.label));
        return roles.length === j.roles.length && industries.length === j.industries.length ? { roles, industries } : null;
      }),
    start: ({ role, industry, text }) => {
      const posting = text.trim();
      return call('POST', '/courses', { role, mode: 'list', ...(industry ? { industry } : {}), ...(posting ? { text: posting } : {}) }, readStarted);
    },
    approve: (courseId) => call('POST', `/courses/${id(courseId)}/approve`, undefined, readStep),
    cancel: (courseId) => call('POST', `/courses/${id(courseId)}/cancel`, undefined, readStep),
    home: (courseId) => call('GET', `/courses/${id(courseId)}`, undefined, readHome),
    mine: () => call('GET', '/me/courses', undefined, (j) => (isObject(j) && Array.isArray(j.courses) ? j.courses.map(readMine).filter((l): l is MyList => l !== null) : null)),
    open: (courseId) => call('POST', `/me/courses/${id(courseId)}/open`, undefined, () => null),
    rename: (courseId, title) => call('PATCH', `/me/courses/${id(courseId)}`, { title }, () => null),
    remove: (courseId) => call('DELETE', `/me/courses/${id(courseId)}`, undefined, () => null),
    refresh: (courseId) => call('POST', `/courses/${id(courseId)}/refresh`, undefined, (j) => (isObject(j) && (j.status === 'up_to_date' || j.status === 'queued') ? { status: j.status, repeat: j.repeat === true } : null)),
    changes: (courseId, since) =>
      call('GET', `/courses/${id(courseId)}/changes?since=${since}`, undefined, (j) => {
        if (!isObject(j) || !num(j.current_version) || !Array.isArray(j.changes)) return null;
        const changes = j.changes.map(readChange);
        return changes.some((c) => c === null) ? null : { currentVersion: j.current_version, changes: changes as CourseChange[] };
      }),
    seen: (courseId, version) => call('POST', `/me/courses/${id(courseId)}/seen`, { version }, () => null),
  };
}
