import { createCourseApi } from './courseApi';

const BASE = 'https://api.example.test/';
const json = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body }) as unknown as Response;
const api = (fetchFn: jest.Mock, token: string | null = 'tok') => createCourseApi(BASE, async () => token, fetchFn as unknown as typeof fetch);
const call = (fetchFn: jest.Mock, n = 0) => fetchFn.mock.calls[n] as unknown as [string, RequestInit];

const concept = (over: Record<string, unknown> = {}) => ({
  id: 'k1', name: 'sql', display_name: 'SQL for analytics', position: 1, band: 'strong', explanation: 'Query data.', criticality: 'high', in_your_posting: false, tools: [],
  resources: [
    { kind: 'article', title: 'Mode SQL Tutorial', source: 'mode.com', url: 'https://mode.com/sql', why: 'teaches it', vetted: true },
    { kind: 'article', title: 'Practice set', source: 'example.org', url: 'https://example.org/p', why: '', vetted: false },
  ],
  ...over,
});
const ready = (over: Record<string, unknown> = {}) => ({
  id: 'c1', status: 'ready', title: 'data engineer', role: 'data engineer', industry: 'healthcare', industry_label: 'Healthcare', mode: 'list', has_updates: true, seen_version: 2,
  coverage: { total: 1, strong: 1, thin: 0, missing: 0, library_backed: 1, with_any_link: 1, library_version: 3, rated_at: '2026-10-18T10:00:00.000Z' },
  concepts: [concept()],
  ...over,
});

describe('courseApi: how it asks', () => {
  it('sends the session token, and with no session does not ask at all', async () => {
    const fetchFn = jest.fn(async () => json(200, { courses: [] }));
    await api(fetchFn).mine();
    const [url, init] = call(fetchFn);
    expect(url).toBe('https://api.example.test/me/courses');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const none = jest.fn();
    expect(await api(none, null).mine()).toEqual({ kind: 'unauthorized' });
    expect(none).not.toHaveBeenCalled();
  });

  it('starting a list course asks for mode list, and sends the industry and posting only when there are some', async () => {
    const fetchFn = jest.fn(async () => json(202, { course_id: 'c1', status: 'finding_sources' }));
    expect(await api(fetchFn).start({ role: 'business analyst', industry: 'fintech', text: '  Build pipelines  ' })).toEqual({ kind: 'ok', value: { courseId: 'c1', status: 'finding_sources', existing: false } });
    let [url, init] = call(fetchFn);
    expect([url, init.method]).toEqual(['https://api.example.test/courses', 'POST']);
    expect(JSON.parse(init.body as string)).toEqual({ role: 'business analyst', mode: 'list', industry: 'fintech', text: 'Build pipelines' });
    const bare = jest.fn(async () => json(200, { course_id: 'c2', status: 'ready', existing: true }));
    expect(await api(bare).start({ role: 'product manager', industry: '', text: '   ' })).toEqual({ kind: 'ok', value: { courseId: 'c2', status: 'ready', existing: true } });
    [url, init] = call(bare);
    expect(JSON.parse(init.body as string)).toEqual({ role: 'product manager', mode: 'list' });
  });

  it('refusals keep the server code', async () => {
    const fetchFn = jest.fn(async () => json(429, { error: 'daily_limit', retry_at: '2026-10-19T00:00:00.000Z' }));
    expect(await api(fetchFn).start({ role: 'business analyst', industry: '', text: '' })).toEqual({ kind: 'refused', status: 429, code: 'daily_limit', retryAt: '2026-10-19T00:00:00.000Z' });
    expect(await api(jest.fn(async () => json(400, { error: 'list_mode_unavailable' }))).start({ role: 'x', industry: '', text: '' })).toEqual({ kind: 'refused', status: 400, code: 'list_mode_unavailable' });
  });

  it('each call goes to its own route, with ids put in the path safely', async () => {
    const cases: Array<[(a: ReturnType<typeof api>) => Promise<unknown>, string, string]> = [
      [(a) => a.approve('c/1'), 'POST', '/courses/c%2F1/approve'],
      [(a) => a.cancel('c/1'), 'POST', '/courses/c%2F1/cancel'],
      [(a) => a.home('c1'), 'GET', '/courses/c1'],
      [(a) => a.changes('c1', 2), 'GET', '/courses/c1/changes?since=2'],
      [(a) => a.seen('c1', 4), 'POST', '/me/courses/c1/seen'],
      [(a) => a.options(), 'GET', '/courses/options'],
    ];
    for (const [run, method, path] of cases) {
      const fetchFn = jest.fn(async () => json(200, {}));
      await run(api(fetchFn));
      const [url, init] = call(fetchFn);
      expect([init.method, url]).toEqual([method, `https://api.example.test${path}`]);
    }
  });

  it('marking seen sends the version', async () => {
    const fetchFn = jest.fn(async () => json(204, null));
    expect(await api(fetchFn).seen('c1', 4)).toEqual({ kind: 'ok', value: null });
    expect(JSON.parse(call(fetchFn)[1].body as string)).toEqual({ version: 4 });
  });
});

describe('courseApi: what comes back', () => {
  it('a ready list course keeps its concepts in order with their bands and resources, vetted or not', async () => {
    const r = await api(jest.fn(async () => json(200, ready({ concepts: [concept({ position: 2, display_name: 'B' }), concept({ id: 'k0', position: 1, display_name: 'A' })] })))).home('c1');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok' || r.value.status !== 'ready') throw new Error('expected ready');
    expect(r.value.concepts.map((c) => c.displayName)).toEqual(['A', 'B']);
    expect(r.value.concepts[0]).toMatchObject({ id: 'k0', band: 'strong', position: 1 });
    expect(r.value.concepts[1]!.resources[0]).toEqual({ title: 'Mode SQL Tutorial', source: 'mode.com', url: 'https://mode.com/sql', vetted: true });
    expect(r.value.coverage).toEqual({ total: 1, strong: 1, thin: 0, missing: 0 });
    expect(r.value).toMatchObject({ role: 'data engineer', industry: 'healthcare', industryLabel: 'Healthcare', hasUpdates: true, seenVersion: 2 });
  });

  it('a concept with a name only (no display name) shows the name', async () => {
    const r = await api(jest.fn(async () => json(200, ready({ concepts: [concept({ display_name: null })] })))).home('c1');
    if (r.kind !== 'ok' || r.value.status !== 'ready') throw new Error('expected ready');
    expect(r.value.concepts[0]!.displayName).toBe('sql');
  });

  it('a course still being made reports its stage and percent; one that failed or was cancelled, just its status', async () => {
    const building = await api(jest.fn(async () => json(200, { id: 'c1', status: 'building', title: 't', role: 'data engineer', industry: null, mode: 'list', stage: 'reference', percent: 62 }))).home('c1');
    expect(building).toEqual({ kind: 'ok', value: { status: 'building', role: 'data engineer', industry: null, stage: 'reference', percent: 62 } });
    const finding = await api(jest.fn(async () => json(200, { id: 'c1', status: 'finding_sources', title: 't', role: 'data engineer', industry: 'fintech', mode: 'list' }))).home('c1');
    expect(finding).toEqual({ kind: 'ok', value: { status: 'finding_sources', role: 'data engineer', industry: 'fintech', stage: '', percent: 0 } });
    const failed = await api(jest.fn(async () => json(200, { id: 'c1', status: 'failed', title: 't', role: 'r', industry: null, mode: 'list', failure_reason: 'x' }))).home('c1');
    expect(failed).toMatchObject({ kind: 'ok', value: { status: 'failed' } });
  });

  it('a narrative course is not a list course here', async () => {
    expect(await api(jest.fn(async () => json(200, { ...ready(), mode: 'narrow', concepts: undefined }))).home('c1')).toEqual({ kind: 'failed', server: true });
  });

  it('nonsense is failed, never a crash', async () => {
    expect(await api(jest.fn(async () => json(200, { status: 'ready' }))).home('c1')).toEqual({ kind: 'failed', server: true });
    expect(await api(jest.fn(async () => json(200, ready({ concepts: [concept({ band: 'great' })] })))).home('c1')).toEqual({ kind: 'failed', server: true });
    expect(await api(jest.fn(async () => { throw new Error('offline'); })).home('c1')).toEqual({ kind: 'failed' });
  });

  it('changes keep the coverage improvements, newest first, with the version they came in', async () => {
    const body = { current_version: 3, changes: [{ id: 'a', version: 3, kind: 'coverage_improved', target: 'k1', summary: 'FHIR data formats: now thin, with 1 library source (was missing)', published_at: '2026-10-17T09:00:00.000Z' }] };
    expect(await api(jest.fn(async () => json(200, body))).changes('c1', 2)).toEqual({
      kind: 'ok',
      value: { currentVersion: 3, changes: [{ id: 'a', version: 3, kind: 'coverage_improved', target: 'k1', summary: body.changes[0]!.summary, publishedAt: '2026-10-17T09:00:00.000Z' }] },
    });
  });

  it('the options are the list roles and the industries the server offers', async () => {
    const body = { roles: [{ name: 'business analyst', label: 'Business analyst', available: true }], industries: [{ key: 'fintech', label: 'Fintech' }] };
    expect(await api(jest.fn(async () => json(200, body))).options()).toEqual({ kind: 'ok', value: body });
    expect(await api(jest.fn(async () => json(200, { roles: 'x', industries: [] }))).options()).toEqual({ kind: 'failed', server: true });
  });

  it('approve answers with the status the course moved to', async () => {
    expect(await api(jest.fn(async () => json(200, { course_id: 'c1', status: 'building' }))).approve('c1')).toEqual({ kind: 'ok', value: { courseId: 'c1', status: 'building' } });
    expect(await api(jest.fn(async () => json(409, { error: 'not_enough_postings' }))).approve('c1')).toEqual({ kind: 'refused', status: 409, code: 'not_enough_postings' });
  });
});

describe('courseApi: a reader\'s lists', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'c1', title: 'business analyst', role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', independent: true, industry: 'fintech', industry_label: 'Fintech',
    custom_title: null, created_at: '2026-10-19T09:00:00.000Z', last_active_at: '2026-10-19T10:00:00.000Z', checked_at: '2026-10-19T09:30:00.000Z', refreshing: false,
    coverage: { total: 10, strong: 5, thin: 3, missing: 2 }, has_updates: true, progress: { read: 0, total: 0 }, ...over,
  });

  it('mine gives each list with what a list screen shows', async () => {
    const r = await api(jest.fn(async () => json(200, { courses: [entry(), entry({ id: 'c2', custom_title: 'Treasury role', coverage: null, status: 'building', checked_at: null, industry: null, industry_label: null, has_updates: undefined })] }))).mine();
    expect(r).toEqual({
      kind: 'ok',
      value: [
        { id: 'c1', role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: 'fintech', industryLabel: 'Fintech', customTitle: null, createdAt: '2026-10-19T09:00:00.000Z', lastActiveAt: '2026-10-19T10:00:00.000Z', checkedAt: '2026-10-19T09:30:00.000Z', refreshing: false, coverage: { total: 10, strong: 5, thin: 3, missing: 2 }, hasUpdates: true },
        { id: 'c2', role: 'business analyst', status: 'building', mode: 'list', visibility: 'private', industry: null, industryLabel: null, customTitle: 'Treasury role', createdAt: '2026-10-19T09:00:00.000Z', lastActiveAt: '2026-10-19T10:00:00.000Z', checkedAt: null, refreshing: false, coverage: null, hasUpdates: false },
      ],
    });
  });

  it('mine leaves out a course it cannot read rather than failing, and fails on nonsense', async () => {
    const r = await api(jest.fn(async () => json(200, { courses: [entry(), { id: 'x' }, entry({ id: 'c3' })] }))).mine();
    expect(r.kind === 'ok' && r.value.map((l) => l.id)).toEqual(['c1', 'c3']);
    expect(await api(jest.fn(async () => json(200, { courses: 'no' }))).mine()).toEqual({ kind: 'failed', server: true });
  });

  it('each action goes to its own route with the right body', async () => {
    const cases: Array<[(a: ReturnType<typeof api>) => Promise<unknown>, string, string, unknown]> = [
      [(a) => a.open('c/1'), 'POST', '/me/courses/c%2F1/open', undefined],
      [(a) => a.rename('c1', 'My list'), 'PATCH', '/me/courses/c1', { title: 'My list' }],
      [(a) => a.rename('c1', null), 'PATCH', '/me/courses/c1', { title: null }],
      [(a) => a.remove('c1'), 'DELETE', '/me/courses/c1', undefined],
      [(a) => a.refresh('c1'), 'POST', '/courses/c1/refresh', undefined],
    ];
    for (const [run, method, path, body] of cases) {
      const fetchFn = jest.fn(async () => json(204, null));
      await run(api(fetchFn));
      const [url, init] = call(fetchFn);
      expect([init.method, url]).toEqual([method, `https://api.example.test${path}`]);
      expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
    }
  });

  it('refresh says up to date or queued, and the hourly limit comes back with when to try again', async () => {
    expect(await api(jest.fn(async () => json(200, { course_id: 'c1', status: 'up_to_date' }))).refresh('c1')).toEqual({ kind: 'ok', value: { status: 'up_to_date', repeat: false } });
    expect(await api(jest.fn(async () => json(202, { course_id: 'c1', status: 'queued' }))).refresh('c1')).toEqual({ kind: 'ok', value: { status: 'queued', repeat: false } });
    expect(await api(jest.fn(async () => json(200, { course_id: 'c1', status: 'queued', repeat: true }))).refresh('c1')).toEqual({ kind: 'ok', value: { status: 'queued', repeat: true } });
    expect(await api(jest.fn(async () => json(429, { error: 'refresh_limit', retry_at: '2026-10-19T15:00:00.000Z' }))).refresh('c1')).toEqual({ kind: 'refused', status: 429, code: 'refresh_limit', retryAt: '2026-10-19T15:00:00.000Z' });
  });

  it('a refusal with no time to try again has none', async () => {
    expect(await api(jest.fn(async () => json(400, { error: 'invalid_title' }))).rename('c1', '')).toEqual({ kind: 'refused', status: 400, code: 'invalid_title' });
  });

  it('the options say which roles can be started', async () => {
    const body = { roles: [{ name: 'business analyst', label: 'Business analyst', available: true }, { name: 'product manager', label: 'Product manager', available: false }], industries: [] };
    expect(await api(jest.fn(async () => json(200, body))).options()).toEqual({ kind: 'ok', value: body });
    const old = await api(jest.fn(async () => json(200, { roles: [{ name: 'x', label: 'X' }], industries: [] }))).options();
    expect(old).toEqual({ kind: 'ok', value: { roles: [{ name: 'x', label: 'X', available: true }], industries: [] } });
  });
});

describe('a concept with no explanation', () => {
  it('reads like any other: the app never shows a concept explanation, so an empty one (a concept backed only by a link-only source) invents no text and breaks nothing', async () => {
    const r = await api(jest.fn(async () => json(200, ready({ concepts: [concept({ explanation: '' }), concept({ id: 'k2', position: 2, explanation: undefined })] })))).home('c1');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok' || r.value.status !== 'ready') throw new Error('expected a ready list');
    expect(r.value.concepts.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(r.value.concepts.every((c) => !('explanation' in c))).toBe(true);
    expect(r.value.concepts[0]!.resources).toHaveLength(2);
  });
});

describe('home evidence', () => {
  const home = (evidence?: unknown) => ({ status: 'ready', role: 'ba', mode: 'list', coverage: { total: 0, strong: 0, thin: 0, missing: 0 }, concepts: [], evidence });
  it('reads the evidence note, and tolerates a server that sends none', async () => {
    const f = (body: unknown) => api(jest.fn(async () => json(200, body)));
    const a = await f(home({ thin: true, similar_postings: 3, own_posting: true })).home('c1');
    expect(a.kind === 'ok' && a.value.status === 'ready' && a.value.evidence).toEqual({ thin: true, similarPostings: 3, ownPosting: true });
    const b = await f(home()).home('c1');
    expect(b.kind === 'ok' && b.value.status === 'ready' && b.value.evidence).toBeNull();
  });
});

describe('telling the connection\'s trouble from the server\'s', () => {
  it('a reply that is a server error (any 5xx), or one that is not usable, is the server\'s trouble', async () => {
    for (const status of [500, 502, 503, 504]) {
      expect(await api(jest.fn(async () => json(status, { error: 'courses unavailable' }))).approve('c1')).toEqual({ kind: 'failed', server: true });
    }
    expect(await api(jest.fn(async () => json(302, {}))).approve('c1')).toEqual({ kind: 'failed', server: true });
  });

  it('no reply at all (no network, a timeout) is the connection\'s trouble, with no server flag', async () => {
    expect(await api(jest.fn(async () => { throw new TypeError('Network request failed'); })).approve('c1')).toEqual({ kind: 'failed' });
    const hang = jest.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await createCourseApi(BASE, async () => 'tok', hang as unknown as typeof fetch, 20).approve('c1')).toEqual({ kind: 'failed' });
  });

  it('a clear refusal (400, 403, 404, 409, 429) is still a refusal with its code', async () => {
    for (const status of [400, 403, 404, 409, 429]) expect(await api(jest.fn(async () => json(status, { error: 'some_code' }))).approve('c1')).toMatchObject({ kind: 'refused', status, code: 'some_code' });
  });
});
