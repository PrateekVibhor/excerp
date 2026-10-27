import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import type { MyList } from '../../data/courseApi';
import { createListsStore, type ListsStore } from '../../data/listsStore';
import { byLabel, mount, press, text, unmountAll } from '../readers/testing';
import { ListsTab } from './ListsTab';
import { fakeCourses, ok, ready, refused } from './testing';
import { CANCELLED_NOTE } from './courseMessages';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams, useFocusEffect: (cb: () => void) => require('react').useEffect(cb, [cb]) }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ courseApi: null, listsStore: null, lastListStore: { get: async () => null, set: async () => {}, clear: async () => {} } }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const mk = (id: string, over: Partial<MyList> = {}): MyList => ({
  id, role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: 'fintech', industryLabel: 'Fintech', customTitle: `List ${id}`,
  createdAt: '2026-10-19T09:00:00.000Z', lastActiveAt: '2026-10-19T10:00:00.000Z', checkedAt: '2026-10-19T09:30:00.000Z', refreshing: false, coverage: { total: 3, strong: 1, thin: 1, missing: 1 }, hasUpdates: false, ...over,
});
const last = (initial: string | null = null) => ({ get: jest.fn(async () => initial), set: jest.fn(async () => {}), clear: jest.fn(async () => {}) });

function setup(lists: MyList[], extra: { api?: Partial<Parameters<typeof fakeCourses>[0]>; remembered?: string | null } = {}) {
  const current = { lists };
  const mine = jest.fn(async () => ok(current.lists));
  const api = fakeCourses({ mine, home: jest.fn(async () => ok(ready())), ...extra.api });
  const store: ListsStore = createListsStore({ mine });
  const lastStore = last(extra.remembered ?? null);
  const open = () => mount(<SafeAreaProvider initialMetrics={metrics}><ListsTab api={api} store={store} last={lastStore} /></SafeAreaProvider>);
  return { api, store, lastStore, current, mine, open };
}
const homeIds = (api: ReturnType<typeof fakeCourses>) => api.home.mock.calls.map((c) => c[0]);
const type = (r: Awaited<ReturnType<ReturnType<typeof setup>['open']>>, value: string) => act(async () => { r.root.findByType(TextInput).props.onChangeText(value); });

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

afterEach(unmountAll);

describe('ListsTab: opening', () => {
  it('opens the most recently used list, with the tab\'s hamburger and the list\'s own title at the top', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    expect(homeIds(s.api)).toEqual(['a']);
    expect(text(r)).toContain('List a');
    expect(byLabel(r, 'Open lists')).toHaveLength(1);
    expect(byLabel(r, 'List options')).toHaveLength(1);
    expect(byLabel(r, 'Back')).toHaveLength(0);
  });

  it('opens the list the reader had open last, if it is still there', async () => {
    const s = setup([mk('a'), mk('b')], { remembered: 'b' });
    await s.open();
    expect(homeIds(s.api)).toEqual(['b']);
  });

  it('falls back to the most recent list when the remembered one is gone', async () => {
    const s = setup([mk('a'), mk('b')], { remembered: 'zzz' });
    await s.open();
    expect(homeIds(s.api)).toEqual(['a']);
  });

  it('opens the list it was sent to (a list just started), and remembers it', async () => {
    mockParams = { open: 'b' };
    const s = setup([mk('a'), mk('b')]);
    await s.open();
    expect(homeIds(s.api)).toEqual(['b']);
    expect(s.lastStore.set).toHaveBeenCalledWith('b');
  });

  it('a list it was sent to that never turns up does not hold the tab on a spinner: the reader\'s lists show as they are', async () => {
    mockParams = { open: 'ghost' };
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    expect(homeIds(s.api)).toEqual(['a']);
    expect(text(r)).toContain('List a');
  });

  it('with no lists it invites the reader to build the first one, and the button opens the intake', async () => {
    const s = setup([]);
    const r = await s.open();
    expect(text(r)).toContain('No skills lists yet');
    expect(byLabel(r, 'Open lists')).toHaveLength(1);
    await press(r, 'Build your first skills list');
    expect(mockRouter.push).toHaveBeenCalledWith('/courses/new');
    expect(s.api.home).not.toHaveBeenCalled();
  });

  it('says so when the lists cannot be loaded, and Retry asks again', async () => {
    const mine = jest.fn().mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValue(ok([mk('a')]));
    const api = fakeCourses({ mine, home: jest.fn(async () => ok(ready())) });
    const r = await mount(<SafeAreaProvider initialMetrics={metrics}><ListsTab api={api} store={createListsStore({ mine })} last={last()} /></SafeAreaProvider>);
    expect(text(r)).toContain("Couldn't load your lists");
    await press(r, 'Retry');
    expect(text(r)).toContain('List a');
  });

  it('with no server (mock data) it says skills lists need the live app', async () => {
    const r = await mount(<SafeAreaProvider initialMetrics={metrics}><ListsTab api={null} store={null} last={last()} /></SafeAreaProvider>);
    expect(text(r)).toContain('Skills lists need the live app and a signed-in account.');
  });
});

describe('ListsTab: the list panel', () => {
  it('the hamburger opens it, with the reader\'s lists', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    expect(text(r)).not.toContain('Skills lists');
    await press(r, 'Open lists');
    expect(text(r)).toContain('Skills lists');
    expect(byLabel(r, 'List b')).toHaveLength(1);
  });

  it('choosing a list opens it, counts it as used, remembers it and closes the panel', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    await press(r, 'Open lists');
    await press(r, 'List b');
    expect(s.api.open).toHaveBeenCalledWith('b');
    expect(s.lastStore.set).toHaveBeenCalledWith('b');
    expect(homeIds(s.api)).toEqual(['a', 'b']);
    expect(s.store.get().lists[0]!.id).toBe('b');
    expect(text(r)).not.toContain('Skills lists');
  });

  it('New list opens the intake and closes the panel', async () => {
    const s = setup([mk('a')]);
    const r = await s.open();
    await press(r, 'Open lists');
    await press(r, 'New list');
    expect(mockRouter.push).toHaveBeenCalledWith('/courses/new');
    expect(text(r)).not.toContain('Skills lists');
  });

  it('a list that is still being built is in the panel and opens to its building screen', async () => {
    const s = setup([mk('a'), mk('b', { status: 'building', coverage: null })], { api: { home: jest.fn(async (id: string) => ok(id === 'b' ? ({ status: 'building', role: 'business analyst', industry: null, stage: 'reference', percent: 62 } as never) : ready())) } });
    const r = await s.open();
    await press(r, 'Open lists');
    await press(r, 'List b');
    expect(text(r)).toContain('Building your list');
    expect(text(r)).toContain('62%');
  });
});

describe('ListsTab: rename', () => {
  it('the menu\'s Rename asks for a name, and saving shows it at once', async () => {
    const s = setup([mk('a')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Rename');
    expect(r.root.findByType(TextInput).props.value).toBe('List a');
    await type(r, '  Treasury systems role ');
    await press(r, 'Save');
    expect(s.api.rename).toHaveBeenCalledWith('a', 'Treasury systems role');
    expect(s.store.get().lists[0]!.customTitle).toBe('Treasury systems role');
    expect(text(r)).toContain('Treasury systems role');
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('an empty name clears it: the default title comes back', async () => {
    const s = setup([mk('a')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Rename');
    await type(r, '');
    await press(r, 'Save');
    expect(s.api.rename).toHaveBeenCalledWith('a', null);
    expect(s.store.get().lists[0]!.customTitle).toBeNull();
    expect(text(r)).toContain('Business analyst · Fintech · Oct 19');
  });

  it('a name the server refuses is explained, and the dialog stays', async () => {
    const s = setup([mk('a')], { api: { rename: jest.fn(async () => refused(400, 'invalid_title')) } });
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Rename');
    await type(r, 'x');
    await press(r, 'Save');
    expect(text(r)).toContain('between 1 and 80 characters');
    expect(r.root.findAllByType(TextInput)).toHaveLength(1);
    expect(s.store.get().lists[0]!.customTitle).toBe('List a');
  });

  it('a list can be renamed from the panel too, without opening it', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    await press(r, 'Open lists');
    await press(r, 'More options for List b');
    await press(r, 'Rename');
    await type(r, 'Second');
    await press(r, 'Save');
    expect(s.api.rename).toHaveBeenCalledWith('b', 'Second');
    expect(homeIds(s.api)).toEqual(['a']);
  });
});

describe('ListsTab: delete', () => {
  it('a private list asks first, saying the list and its posting are deleted; confirming removes it and opens the next', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Delete');
    expect(text(r)).toContain('Delete this list?');
    expect(text(r)).toContain('deletes the list and the job posting you pasted');
    expect(s.api.remove).not.toHaveBeenCalled();
    await press(r, 'Delete list');
    expect(s.api.remove).toHaveBeenCalledWith('a');
    expect(s.store.get().lists.map((l) => l.id)).toEqual(['b']);
    expect(homeIds(s.api).at(-1)).toBe('b');
  });

  it('a shared list asks differently: it only removes it from the reader\'s own lists', async () => {
    const s = setup([mk('a', { visibility: 'shared' }), mk('b')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Delete');
    expect(text(r)).toContain('Remove this list?');
    expect(text(r)).toContain('only removes it from your lists');
    expect(text(r)).toContain('Other readers keep it');
    await press(r, 'Remove list');
    expect(s.api.remove).toHaveBeenCalledWith('a');
  });

  it('Cancel changes nothing', async () => {
    const s = setup([mk('a')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Delete');
    await press(r, 'Cancel');
    expect(s.api.remove).not.toHaveBeenCalled();
    expect(s.store.get().lists).toHaveLength(1);
  });

  it('deleting the last list leaves the empty state', async () => {
    const s = setup([mk('a')]);
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Delete');
    await press(r, 'Delete list');
    expect(text(r)).toContain('No skills lists yet');
    expect(s.lastStore.clear).toHaveBeenCalled();
  });

  it('a delete that fails says so and keeps the list', async () => {
    const s = setup([mk('a')], { api: { remove: jest.fn(async () => ({ kind: 'failed' as const })) } });
    const r = await s.open();
    await press(r, 'List options');
    await press(r, 'Delete');
    await press(r, 'Delete list');
    expect(text(r)).toContain("Couldn't reach the server");
    expect(s.store.get().lists).toHaveLength(1);
  });

  it('a list can be deleted from the panel, and the open list stays open', async () => {
    const s = setup([mk('a'), mk('b')]);
    const r = await s.open();
    await press(r, 'Open lists');
    await press(r, 'More options for List b');
    await press(r, 'Delete');
    await press(r, 'Delete list');
    expect(s.api.remove).toHaveBeenCalledWith('b');
    expect(s.store.get().lists.map((l) => l.id)).toEqual(['a']);
    expect(homeIds(s.api)).toEqual(['a']);
  });
});

describe('ListsTab: refresh now', () => {
  const menuRefresh = async (r: Awaited<ReturnType<ReturnType<typeof setup>['open']>>) => {
    await press(r, 'List options');
    await press(r, 'Refresh now');
  };

  it('the menu shows when the list was last checked, and "Up to date" comes back at once when nothing is new', async () => {
    const s = setup([mk('a', { checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() })], { api: { refresh: jest.fn(async () => ok({ status: 'up_to_date', repeat: false })) } });
    const r = await s.open();
    await press(r, 'List options');
    expect(text(r)).toContain('Checked 5 min ago');
    await press(r, 'Refresh now');
    expect(s.api.refresh).toHaveBeenCalledWith('a');
    expect(text(r)).toContain('Up to date');
  });

  it('when a check is queued the list shows a checking state, and when it finishes says so and reloads the list', async () => {
    jest.useFakeTimers();
    try {
      const s = setup([mk('a')], { api: { refresh: jest.fn(async () => ok({ status: 'queued', repeat: false })) } });
      const r = await s.open();
      await menuRefresh(r);
      expect(s.store.get().lists[0]!.refreshing).toBe(true);
      expect(text(r)).toContain('Checking for new sources');
      const asked = s.api.home.mock.calls.length;
      s.current.lists = [mk('a', { refreshing: false, checkedAt: new Date().toISOString() })];
      await act(async () => { jest.advanceTimersByTime(3100); });
      expect(s.store.get().lists[0]!.refreshing).toBe(false);
      expect(text(r)).toContain('Checked just now');
      expect(s.api.home.mock.calls.length).toBeGreaterThan(asked);
    } finally {
      jest.useRealTimers();
    }
  });

  it('says when the check found new coverage', async () => {
    jest.useFakeTimers();
    try {
      const s = setup([mk('a')], { api: { refresh: jest.fn(async () => ok({ status: 'queued', repeat: false })) } });
      const r = await s.open();
      await menuRefresh(r);
      s.current.lists = [mk('a', { refreshing: false, hasUpdates: true })];
      await act(async () => { jest.advanceTimersByTime(3100); });
      expect(text(r)).toContain('New coverage found');
    } finally {
      jest.useRealTimers();
    }
  });

  it('while a check is under way Refresh now cannot be pressed again', async () => {
    const s = setup([mk('a', { refreshing: true })]);
    const r = await s.open();
    await press(r, 'List options');
    expect(byLabel(r, 'Refresh now')[0]!.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('the once-an-hour limit is explained with when to try again', async () => {
    const s = setup([mk('a')], { api: { refresh: jest.fn(async () => refused(429, 'refresh_limit')) } });
    s.api.refresh.mockResolvedValue({ kind: 'refused', status: 429, code: 'refresh_limit', retryAt: '2026-10-19T15:40:00.000Z' });
    const r = await s.open();
    await menuRefresh(r);
    expect(text(r)).toContain('You can check this list once an hour. Try again at');
  });

  it('a check that could not be asked for says so', async () => {
    const s = setup([mk('a')], { api: { refresh: jest.fn(async () => ({ kind: 'failed' as const })) } });
    const r = await s.open();
    await menuRefresh(r);
    expect(text(r)).toContain("Couldn't reach the server");
  });

  it('a list that is not ready cannot be checked yet', async () => {
    const s = setup([mk('a', { status: 'building', coverage: null })], { api: { home: jest.fn(async () => ok({ status: 'building', role: 'business analyst', industry: null, stage: 'read', percent: 5 } as never)) } });
    const r = await s.open();
    await press(r, 'List options');
    expect(byLabel(r, 'Refresh now')[0]!.props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('ListsTab: new coverage', () => {
  it('dismissing what is new on the open list takes the dot off at once', async () => {
    const s = setup([mk('a', { hasUpdates: true })], { api: { changes: jest.fn(async () => ok({ currentVersion: 3, changes: [{ id: 'x', version: 3, kind: 'coverage_improved', target: 'k', summary: 'Concept 2: now thin, with 1 vetted source (was missing)', publishedAt: '2026-10-13T09:00:00.000Z' }] })), home: jest.fn(async () => ok(ready({ hasUpdates: true }))) } });
    const r = await s.open();
    await press(r, "Dismiss what's new");
    expect(s.store.get().lists[0]!.hasUpdates).toBe(false);
  });
});

const growing = (status: string) => jest.fn(async () => ok({ status, role: 'business analyst', industry: null, stage: 'reference', percent: 40 } as never));
const stoppable = (status = 'building') => setup([mk('a', { status, coverage: null })], { api: { home: growing(status), cancel: jest.fn(async () => ok(null)) } });
const openMenu = async (r: Awaited<ReturnType<ReturnType<typeof setup>['open']>>) => press(r, 'List options');

describe('ListsTab: cancel build', () => {
  it('the menu offers Cancel build for a list that is finding sources, waiting for approval or building, and Close instead of Cancel', async () => {
    for (const status of ['finding_sources', 'awaiting_approval', 'building']) {
      const r = await stoppable(status).open();
      await openMenu(r);
      expect(byLabel(r, 'Cancel build')).toHaveLength(1);
      expect(byLabel(r, 'Close')).toHaveLength(1);
      expect(byLabel(r, 'Cancel')).toHaveLength(0);
      await unmountAll();
    }
  });

  it('a ready, failed or already cancelled list has no Cancel build', async () => {
    for (const status of ['ready', 'failed', 'cancelled']) {
      const s = setup([mk('a', { status })], { api: { home: status === 'ready' ? jest.fn(async () => ok(ready())) : growing(status) } });
      const r = await s.open();
      await openMenu(r);
      expect(byLabel(r, 'Cancel build')).toHaveLength(0);
      expect(byLabel(r, 'Delete')).toHaveLength(1);
      await unmountAll();
    }
  });

  it('asks "Stop building this list?" with Keep building and Stop building; Keep building sends nothing', async () => {
    const s = stoppable();
    const r = await s.open();
    await openMenu(r);
    await press(r, 'Cancel build');
    expect(text(r)).toContain('Stop building this list?');
    expect(s.api.cancel).not.toHaveBeenCalled();
    expect(byLabel(r, 'Stop building')).toHaveLength(1);
    await press(r, 'Keep building');
    expect(s.api.cancel).not.toHaveBeenCalled();
    expect(text(r)).not.toContain('Stop building this list?');
  });

  it('Stop building sends one cancel, shows Stopping… meanwhile (a second tap sends nothing), then the list shows as stopped', async () => {
    let release!: (v: unknown) => void;
    const cancel = jest.fn(() => new Promise((res) => { release = res; }));
    const s = setup([mk('a', { status: 'building', coverage: null })], { api: { home: growing('building'), cancel } });
    const r = await s.open();
    await openMenu(r);
    await press(r, 'Cancel build');
    await act(async () => { const stop = byLabel(r, 'Stop building')[0]!.props.onPress; stop(); stop(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('a');
    expect(byLabel(r, 'Stopping…')).toHaveLength(1);
    s.api.home.mockImplementation(growing('cancelled'));
    await act(async () => { release(ok(null)); });
    expect(s.store.get().lists[0]!.status).toBe('cancelled');
    expect(text(r)).not.toContain('Stop building this list?');
    expect(text(r)).toContain(CANCELLED_NOTE);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a stopped list keeps Delete in the menu and has no Cancel build', async () => {
    const s = stoppable();
    const r = await s.open();
    await openMenu(r);
    await press(r, 'Cancel build');
    s.api.home.mockImplementation(growing('cancelled'));
    await press(r, 'Stop building');
    await openMenu(r);
    expect(byLabel(r, 'Cancel build')).toHaveLength(0);
    expect(byLabel(r, 'Delete')).toHaveLength(1);
  });

  it('no connection, our trouble and a plain refusal each say what is true, and the dialog stays so the reader can try again', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: 'failed' }, /couldn't reach the server/i],
      [{ kind: 'failed', server: true }, /something went wrong on our side/i],
      [refused(400, 'weird'), /couldn't stop the list/i],
    ];
    for (const [answer, expected] of cases) {
      const s = setup([mk('a', { status: 'building', coverage: null })], { api: { home: growing('building'), cancel: jest.fn(async () => answer as never) } });
      const r = await s.open();
      await openMenu(r);
      await press(r, 'Cancel build');
      await press(r, 'Stop building');
      expect(text(r)).toMatch(expected);
      expect(s.store.get().lists[0]!.status).toBe('building');
      expect(byLabel(r, 'Stop building')).toHaveLength(1); // not stuck on Stopping…
      await unmountAll();
    }
  });

  it('a 409 not_cancellable (it just finished or failed) shows no error: the dialog closes and the status is read again', async () => {
    const s = setup([mk('a', { status: 'building', coverage: null })], { api: { home: growing('building'), cancel: jest.fn(async () => refused(409, 'not_cancellable')) } });
    const r = await s.open();
    await openMenu(r);
    await press(r, 'Cancel build');
    const homeCalls = s.api.home.mock.calls.length;
    const mineCalls = s.mine.mock.calls.length;
    await press(r, 'Stop building');
    expect(text(r)).not.toContain('Stop building this list?');
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'alert')).toHaveLength(0);
    expect(s.api.home.mock.calls.length).toBeGreaterThan(homeCalls);
    expect(s.mine.mock.calls.length).toBeGreaterThan(mineCalls);
  });
});
