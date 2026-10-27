import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { byLabel, mount, text, unmountAll } from '../readers/testing';
import { CourseScreen } from './CourseScreen';
import { fakeCourses, ok, ready, refused } from './testing';

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ courseApi: null }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const open = (api: ReturnType<typeof fakeCourses> | null) => mount(<SafeAreaProvider initialMetrics={metrics}><CourseScreen id="c1" api={api} /></SafeAreaProvider>);
const building = (stage = 'read', percent = 10, status = 'building') => ok({ status, role: 'data engineer', industry: 'healthcare', stage, percent } as never);
const tick = (ms = 3000) => act(async () => { jest.advanceTimersByTime(ms); });

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(async () => {
  await unmountAll(); // while the fake clock is still in place, so no poll is left to fire later
  jest.useRealTimers();
});


describe('CourseScreen', () => {
  it('shows the building screen while the course builds and follows its progress', async () => {
    const home = jest.fn().mockResolvedValueOnce(building('read', 10)).mockResolvedValueOnce(building('reference', 62));
    const r = await open(fakeCourses({ home }));
    expect(text(r)).toContain('Building your list');
    expect(text(r)).toContain('10%');
    await tick();
    expect(text(r)).toContain('62%');
  });

  it('when the list is ready the course home takes its place, and polling stops', async () => {
    const home = jest.fn().mockResolvedValueOnce(building('list', 90)).mockResolvedValue(ok(ready()));
    const r = await open(fakeCourses({ home }));
    await tick();
    expect(text(r)).toContain('Concept 1');
    const calls = home.mock.calls.length;
    await tick(10_000);
    expect(home).toHaveBeenCalledTimes(calls);
  });

  it('Scenario: a list waiting for approval is approved once, with no extra tap, and the build goes on', async () => {
    const home = jest.fn().mockResolvedValueOnce(building('', 0, 'awaiting_approval')).mockResolvedValue(building('read', 5));
    const api = fakeCourses({ home });
    const r = await open(api);
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('c1');
    await tick();
    await tick();
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(text(r)).toContain('5%');
  });

  it('a limit that blocks approval is shown on the building screen, polling stops, and Try again asks once more', async () => {
    const home = jest.fn(async () => building('', 0, 'awaiting_approval'));
    const approve = jest.fn().mockResolvedValueOnce(refused(429, 'course_limit')).mockResolvedValueOnce(ok({ courseId: 'c1', status: 'building' }));
    const r = await open(fakeCourses({ home, approve }));
    expect(text(r)).toContain('one new course a day and three a month');
    const calls = home.mock.calls.length;
    await tick(10_000);
    expect(home).toHaveBeenCalledTimes(calls);
    await act(async () => { byLabel(r, 'Try again')[0]!.props.onPress(); });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(text(r)).not.toContain('one new course a day');
  });

  it('too few postings is explained, not retried automatically', async () => {
    const api = fakeCourses({ home: jest.fn(async () => building('', 0, 'awaiting_approval')), approve: jest.fn(async () => refused(409, 'not_enough_postings')) });
    const r = await open(api);
    expect(text(r)).toContain("enough job postings");
    await tick(10_000);
    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('a build that failed says so and stops', async () => {
    const home = jest.fn(async () => building('', 0, 'failed'));
    const r = await open(fakeCourses({ home }));
    expect(text(r)).toContain("We couldn't build this list");
    await tick(10_000);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('a list the reader stopped is told calmly: no red alert, no Try again, and polling stops', async () => {
    const home = jest.fn(async () => building('reference', 40, 'cancelled'));
    const r = await open(fakeCourses({ home }));
    expect(text(r)).toContain('You stopped this list. Delete it or start a new one.');
    expect(text(r)).not.toContain('Building your list');
    expect(text(r)).not.toContain("couldn't build");
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'alert')).toHaveLength(0);
    expect(byLabel(r, 'Try again')).toHaveLength(0);
    await tick(10_000);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('a lost connection is said once, and the screen keeps trying', async () => {
    const home = jest.fn().mockResolvedValueOnce(building('read', 10)).mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValue(building('reference', 50));
    const r = await open(fakeCourses({ home }));
    await tick();
    expect(text(r)).toContain("Couldn't reach the server");
    await tick();
    expect(text(r)).toContain('50%');
    expect(text(r)).not.toContain("Couldn't reach the server");
  });

  it('a course the reader may not see is not found', async () => {
    const r = await open(fakeCourses({ home: jest.fn(async () => refused(404, '')) }));
    expect(text(r)).toContain("This list isn't available");
  });

  it('stops asking when the screen is left', async () => {
    const home = jest.fn(async () => building('read', 10));
    const r = await open(fakeCourses({ home }));
    const calls = home.mock.calls.length;
    await act(async () => { r.unmount(); });
    await tick(10_000);
    expect(home).toHaveBeenCalledTimes(calls);
  });

  it('with no server (mock data) it says lists need the live app', async () => {
    expect(text(await open(null))).toContain('need the live app');
  });

  describe('inside the Skills list tab', () => {
    const chrome = { title: 'Treasury systems role', left: <Pressable accessibilityRole="button" accessibilityLabel="Open lists" onPress={jest.fn()}><Text>☰</Text></Pressable> };
    const openTab = (api: ReturnType<typeof fakeCourses>, extra: Record<string, unknown> = {}) => mount(<SafeAreaProvider initialMetrics={metrics}><CourseScreen id="c1" api={api} chrome={chrome} {...extra} /></SafeAreaProvider>);

    it('uses the tab\'s buttons while the list builds and once it is ready', async () => {
      const home = jest.fn().mockResolvedValueOnce(building('read', 10)).mockResolvedValue(ok(ready()));
      const r = await openTab(fakeCourses({ home }));
      expect(byLabel(r, 'Open lists')).toHaveLength(1);
      expect(byLabel(r, 'Back')).toHaveLength(0);
      await tick();
      expect(text(r)).toContain('Concept 1');
      expect(byLabel(r, 'Open lists')).toHaveLength(1);
      expect(byLabel(r, 'Back')).toHaveLength(0);
    });

    it('asks for the list again when told something changed (a check finished), without losing its place', async () => {
      const home = jest.fn(async () => ok(ready()));
      const r = await openTab(fakeCourses({ home }), { refreshKey: 0 });
      expect(home).toHaveBeenCalledTimes(1);
      await act(async () => { r.update(<SafeAreaProvider initialMetrics={metrics}><CourseScreen id="c1" api={fakeCourses({ home })} chrome={chrome} refreshKey={1} /></SafeAreaProvider>); });
      expect(home.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(text(r)).toContain('Concept 1');
    });

    it('a list that is not found says so with the tab\'s buttons, not a Back', async () => {
      const r = await openTab(fakeCourses({ home: jest.fn(async () => refused(404, '')) }));
      expect(text(r)).toContain("This list isn't available");
      expect(byLabel(r, 'Open lists')).toHaveLength(1);
    });

    it('passes the last-checked time on to the list', async () => {
      const r = await openTab(fakeCourses({ home: jest.fn(async () => ok(ready())) }), { checkedAt: null });
      expect(text(r)).toContain('Not checked yet');
    });
  });

  describe('approving once, watching on, and saying what is true', () => {
    const awaiting = () => building('', 0, 'awaiting_approval');
    const server = { kind: 'failed', server: true } as never;
    const offline = { kind: 'failed' } as never;
    const SERVER_LINE = "Something went wrong on our side. We're retrying.";
    const OFFLINE_LINE = "Couldn't reach the server. We'll keep trying.";

    it('a second approve is not sent while one is in flight, even when the screen asks again (the effect re-runs) or a second copy of the screen opens', async () => {
      let release!: (v: unknown) => void;
      const approve = jest.fn(() => new Promise((resolve) => { release = resolve; }));
      const api = fakeCourses({ home: jest.fn(async () => awaiting()), approve });
      const tree = (key: number) => <SafeAreaProvider initialMetrics={metrics}><CourseScreen id="c1" api={api} refreshKey={key} /></SafeAreaProvider>;
      const r = await mount(tree(0));
      expect(approve).toHaveBeenCalledTimes(1);
      await act(async () => { r.update(tree(1)); });
      await act(async () => { r.update(tree(2)); });
      await mount(tree(0)); // a second screen for the same list, as a quick remount makes
      expect(api.home.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(approve).toHaveBeenCalledTimes(1);
      await act(async () => { release(ok({ courseId: 'c1', status: 'building' })); });
      expect(approve).toHaveBeenCalledTimes(1);
    });

    it('after a successful approve no second one is sent even if a slow status still says "waiting for approval"', async () => {
      const api = fakeCourses({ home: jest.fn(async () => awaiting()) });
      await open(api);
      await tick();
      await tick();
      expect(api.approve).toHaveBeenCalledTimes(1);
    });

    it('a failed approve does not stop the watching: the status is still asked for, the next poll asks to approve again, and the line clears itself once it is building', async () => {
      const home = jest.fn().mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(awaiting()).mockResolvedValue(building('read', 7));
      const approve = jest.fn().mockResolvedValueOnce(server).mockResolvedValue(ok({ courseId: 'c1', status: 'building' }));
      const r = await open(fakeCourses({ home, approve }));
      expect(text(r)).toContain(SERVER_LINE);
      await tick();
      expect(approve).toHaveBeenCalledTimes(2);
      expect(text(r)).not.toContain(SERVER_LINE);
      await tick();
      expect(text(r)).toContain('7%');
      expect(home.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('an approve that failed but whose list is already building (the server did it) shows no error at all by the next poll', async () => {
      const home = jest.fn().mockResolvedValueOnce(awaiting()).mockResolvedValue(building('read', 4));
      const r = await open(fakeCourses({ home, approve: jest.fn(async () => server) }));
      expect(text(r)).toContain(SERVER_LINE);
      await tick();
      expect(text(r)).not.toContain(SERVER_LINE);
      expect(text(r)).not.toContain("Couldn't reach the server");
      expect(text(r)).toContain('4%');
    });

    it('three different words: no connection, a problem on our side, and the clear refusals keep theirs', async () => {
      const lineFor = async (approve: jest.Mock) => text(await open(fakeCourses({ home: jest.fn(async () => awaiting()), approve })));
      const noConnection = await lineFor(jest.fn(async () => offline));
      expect(noConnection).toContain(OFFLINE_LINE);
      expect(noConnection).not.toContain('our side');
      const ours = await lineFor(jest.fn(async () => server));
      expect(ours).toContain(SERVER_LINE);
      expect(ours).not.toContain("Couldn't reach the server");
      expect(ours).not.toMatch(/connection/i);
      expect(await lineFor(jest.fn(async () => refused(429, 'course_limit')))).toContain('one new course a day and three a month');
      expect(await lineFor(jest.fn(async () => refused(409, 'not_enough_postings')))).toContain('enough job postings');
      expect(await lineFor(jest.fn(async () => refused(400, 'x')))).toContain("Couldn't start building your list. Try again.");
    });

    it('a refusal that says the list is no longer waiting (someone approved or cancelled it) is not shown as an error: the status decides', async () => {
      const home = jest.fn().mockResolvedValueOnce(awaiting()).mockResolvedValue(building('read', 12));
      const r = await open(fakeCourses({ home, approve: jest.fn(async () => refused(409, 'not_awaiting_approval')) }));
      expect(text(r)).not.toContain("Couldn't start building");
      await tick();
      expect(text(r)).toContain('12%');
    });

    it('a server error on the status check says "our side", and clears when the next check works', async () => {
      const home = jest.fn().mockResolvedValueOnce(building('read', 10)).mockResolvedValueOnce(server).mockResolvedValue(building('reference', 50));
      const r = await open(fakeCourses({ home }));
      await tick();
      expect(text(r)).toContain(SERVER_LINE);
      await tick();
      expect(text(r)).not.toContain(SERVER_LINE);
      expect(text(r)).toContain('50%');
    });

    it('a failed list opened cold says it failed as soon as the first answer arrives, and before that shows a neutral Loading… and not the first-step 0% look', async () => {
      let answer!: (v: unknown) => void;
      const home = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
      const r = await open(fakeCourses({ home }));
      expect(text(r)).toContain('Loading…');
      expect(text(r)).not.toContain('Building your list');
      expect(text(r)).not.toContain('0%');
      expect(byLabel(r, 'Reading the job posting, in progress')).toHaveLength(0);
      await act(async () => { answer(building('', 0, 'failed')); });
      expect(text(r)).not.toContain('Loading…');
      expect(text(r)).toContain("We couldn't build this list");
    });

    it('before the first answer, a failure to reach the server is said on the Loading screen too, in the right words', async () => {
      const home = jest.fn().mockResolvedValueOnce(server).mockResolvedValue(building('read', 3));
      const r = await open(fakeCourses({ home }));
      expect(text(r)).toContain('Loading…');
      expect(text(r)).toContain(SERVER_LINE);
      await tick();
      expect(text(r)).not.toContain(SERVER_LINE);
      expect(text(r)).toContain('3%');
    });
  });
});
