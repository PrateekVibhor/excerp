/**
 * The client against the server's REAL answers. realReplies.json was recorded by running the server's own routes over a test database (status code and body of each);
 * nothing in it is hand-written. Every call of courseApi must be here, so a new call cannot ship without a test that feeds it a real reply.
 */
import { createAuthApi } from './authApi';
import { createCourseApi, type CourseApi } from './courseApi';
import replies from './realReplies.json';

type Reply = { method: string; path: string; status: number; body: unknown };
const R = replies as Record<string, Reply>;
const answer = (name: string) => jest.fn(async () => ({ status: R[name]!.status, ok: R[name]!.status < 300, json: async () => R[name]!.body }) as unknown as Response);
const course = (fetchFn: jest.Mock) => createCourseApi('https://api.example.test', async () => 'tok', fetchFn as unknown as typeof fetch);

/** One entry per courseApi call: the recorded reply it is fed, and what it must make of it. */
const CALLS: Record<keyof CourseApi, Array<[fixture: string, run: (a: CourseApi) => Promise<unknown>, expected: (r: unknown) => void]>> = {
  options: [['options', (a) => a.options(), (r) => expect(r).toMatchObject({ kind: 'ok' })]],
  start: [['start', (a) => a.start({ role: 'business analyst', industry: '', text: '' }), (r) => expect(r).toMatchObject({ kind: 'ok', value: { status: 'finding_sources', existing: false } })]],
  approve: [['approve', (a) => a.approve('c1'), (r) => expect(r).toMatchObject({ kind: 'ok', value: { status: 'building' } })]],
  cancel: [['cancel', (a) => a.cancel('c1'), (r) => expect(r).toMatchObject({ kind: 'ok', value: { status: 'cancelled' } })]],
  home: [
    ['homeReady', (a) => a.home('c1'), (r) => expect(r).toMatchObject({ kind: 'ok', value: { status: 'ready' } })],
    ['homeNotReady', (a) => a.home('c1'), (r) => expect(r).toMatchObject({ kind: 'ok', value: { status: 'cancelled' } })],
  ],
  mine: [['mine', (a) => a.mine(), (r) => expect(r).toMatchObject({ kind: 'ok', value: expect.arrayContaining([expect.objectContaining({ role: 'data analyst' })]) })]],
  open: [['open', (a) => a.open('c1'), (r) => expect(r).toEqual({ kind: 'ok', value: null })]],
  rename: [['rename', (a) => a.rename('c1', 'My list'), (r) => expect(r).toEqual({ kind: 'ok', value: null })]],
  remove: [['remove', (a) => a.remove('c1'), (r) => expect(r).toEqual({ kind: 'ok', value: null })]],
  refresh: [
    ['refreshUpToDate', (a) => a.refresh('c1'), (r) => expect(r).toEqual({ kind: 'ok', value: { status: 'up_to_date', repeat: false } })],
    ['refreshQueued', (a) => a.refresh('c1'), (r) => expect(r).toEqual({ kind: 'ok', value: { status: 'queued', repeat: false } })],
  ],
  changes: [['changes', (a) => a.changes('c1', 0), (r) => expect(r).toEqual({ kind: 'ok', value: { currentVersion: 1, changes: [] } })]],
  seen: [['seen', (a) => a.seen('c1', 1), (r) => expect(r).toEqual({ kind: 'ok', value: null })]],
};

describe('courseApi against the real replies', () => {
  it('has a real-reply test for every call (add the call to CALLS, and record its reply, before it can ship)', () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(course(jest.fn())).sort());
  });

  for (const [method, cases] of Object.entries(CALLS)) {
    for (const [fixture, run, expected] of cases) {
      it(`${method}: takes the server's real ${fixture} reply (${R[fixture]!.status}) as a success`, async () => {
        const fetchFn = answer(fixture);
        expected(await run(course(fetchFn)));
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.method).toBe(R[fixture]!.method); // the client asks the way the recorded route was asked
        expect(new URL(url).pathname.replace(/\/c1(\/|$)/, '/:id$1')).toBe(R[fixture]!.path.split('?')[0]);
      });
    }
  }
});

describe('sign-in, session and account deletion against the real replies', () => {
  const auth = (name: string) => createAuthApi('https://api.example.test', answer(name) as unknown as typeof fetch);
  it('signIn: the real approved reply is an approval', async () => {
    expect(await auth('signIn').signIn('id-token')).toMatchObject({ kind: 'approved', token: 'test-session-token' });
  });
  it('checkSession: the real session reply is approved', async () => {
    expect(await auth('session').checkSession('tok')).toMatchObject({ kind: 'approved' });
  });
  it('deleteAccount: the real 204 is deleted', async () => {
    expect(await auth('deleteAccount').deleteAccount('tok', 'device')).toBe('deleted');
  });
  it('signOut: the real 204 does not throw', async () => {
    await expect(auth('signOutOther').signOut('tok')).resolves.toBeUndefined();
  });
});
