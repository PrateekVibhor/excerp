import { ActivityIndicator, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import type { DeviceIdRepository, LeaderboardApi, LeaderboardResponse, LeaderboardRow as Row, SyncQueue } from '../../data';
import { LeaderboardRow } from './LeaderboardRow';
import { LeaderboardScreen } from './LeaderboardScreen';
import type { LeaderboardSources } from './useLeaderboard';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const DEVICE = '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90';
const metrics = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const row = (rank: number, display_name: string, count: number, is_you = false): Row => ({ rank, display_name, count, is_you });

/** Sources whose answers the test controls: the board, how the send ends, and when each call finishes. */
function sources(opts: { board?: LeaderboardResponse | Error; flush?: () => Promise<unknown>; boards?: Array<LeaderboardResponse | Error> } = {}) {
  const asked: Array<string | undefined> = [];
  let calls = 0;
  const api: LeaderboardApi = {
    postVerification: async () => 'sent',
    getLeaderboard: async (id) => {
      asked.push(id);
      const next = opts.boards ? opts.boards[Math.min(calls++, opts.boards.length - 1)] : (opts.board ?? { rows: [], you: null });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const device: DeviceIdRepository = { get: async () => DEVICE, forget: async () => {} };
  const flush = jest.fn(opts.flush ?? (async () => ({ sent: 0, rejected: 0, remaining: 0 })));
  const sync = { enqueue: jest.fn(), flush } as unknown as SyncQueue;
  const all: LeaderboardSources = { api, device, sync };
  return { all, asked, flush };
}

const opened: Array<ReturnType<typeof create>> = [];
async function open(src: LeaderboardSources) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <LeaderboardScreen sources={src} />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  opened.push(renderer);
  const screen = {
    renderer,
    texts: () => [...new Set(renderer.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')))],
    has: (text: string) => screen.texts().includes(text),
    labelled: (label: string) => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.type === 'string'),
    rowLabels: () => renderer.root.findAll((n: ReactTestInstance) => typeof n.type === 'string' && /^\d+\. /.test(String(n.props.accessibilityLabel))).map((n) => n.props.accessibilityLabel as string),
    spinner: () => renderer.root.findAllByType(ActivityIndicator).length,
    press: async (label: string) => {
      const target = renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
      if (!target) throw new Error(`Nothing to press labelled "${label}"`);
      await act(async () => {
        target.props.onPress();
      });
    },
  };
  return screen;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    opened.splice(0).forEach((r) => r.unmount());
  });
  jest.restoreAllMocks();
});

describe('LeaderboardRow', () => {
  const mount = (r: Row) => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LeaderboardRow row={r} />);
    });
    opened.push(renderer);
    return renderer;
  };
  const texts = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));

  it('shows the rank, the name and the count', () => {
    const t = texts(mount(row(3, 'Maya Chen', 7)));
    expect(t).toEqual(expect.arrayContaining(['3', 'Maya Chen', '7']));
    expect(t).not.toContain('VERIFIED'); // no caption beside the number: it would squeeze the name at large text sizes
  });

  it('speaks as one line: "rank. name, count verified"', () => {
    const r = mount(row(3, 'Maya Chen', 7));
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === '3. Maya Chen, 7 verified').length).toBeGreaterThan(0);
  });

  it('marks the reader\'s own row with "(you)" and in what it speaks', () => {
    const r = mount(row(2, 'Daniel', 4, true));
    expect(texts(r).join(' ')).toContain('(you)');
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === '2. Daniel, 4 verified, you').length).toBeGreaterThan(0);
    const other = mount(row(2, 'Daniel', 4));
    expect(texts(other).join(' ')).not.toContain('(you)');
  });

  it('lets a long name take two lines, so large text does not cut it to one', () => {
    const r = mount(row(1, 'A very long display name indeed', 1));
    expect(r.root.findAllByType(Text).find((t) => String(t.props.children).includes('A very long'))?.props.numberOfLines).toBe(2);
  });
});

describe('LeaderboardScreen: the board', () => {
  it('Scenario: Appear on the board - shows each reader with their name and count, in the order the server gave', async () => {
    const screen = await open(sources({ board: { rows: [row(1, 'Maya Chen', 8), row(2, 'Daniel', 5), row(3, 'Priya', 5)], you: null } }).all);
    expect(screen.rowLabels()).toEqual(['1. Maya Chen, 8 verified', '2. Daniel, 5 verified', '3. Priya, 5 verified']);
    expect(screen.has('Leaderboard')).toBe(true);
    expect(screen.has('VERIFIED READERS')).toBe(true);
    // the title shrinks to fit on one line instead of breaking in the middle of the word at large text sizes
    const title = screen.renderer.root.findAllByType(Text).find((t) => String(t.props.children).trim() === 'Leaderboard')!;
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.adjustsFontSizeToFit).toBe(true);
  });

  it('asks for the board with this device\'s id, so its own place can come back', async () => {
    const s = sources({ board: { rows: [row(1, 'Maya', 1)], you: null } });
    await open(s.all);
    expect(s.asked).toEqual([DEVICE]);
  });

  it('Scenario: Own position - the reader\'s own row in the list is marked, and nothing is pinned', async () => {
    const screen = await open(sources({ board: { rows: [row(1, 'Maya', 8), row(2, 'Daniel', 5, true)], you: row(2, 'Daniel', 5, true) } }).all);
    expect(screen.rowLabels()).toEqual(['1. Maya, 8 verified', '2. Daniel, 5 verified, you']);
    expect(screen.has('YOUR PLACE')).toBe(false);
  });

  it('Scenario: Own rank beyond 50 - the top rows, and the reader\'s own rank pinned below the list', async () => {
    const top = Array.from({ length: 50 }, (_, i) => row(i + 1, `Reader ${i + 1}`, 60 - i));
    const screen = await open(sources({ board: { rows: top, you: row(57, 'Maya Chen', 1, true) } }).all);
    expect(screen.rowLabels()).toHaveLength(51); // 50 in the list and the pinned one
    expect(screen.rowLabels().at(-1)).toBe('57. Maya Chen, 1 verified, you');
    expect(screen.rowLabels().slice(0, 50).every((l) => !l.endsWith(', you'))).toBe(true);
    expect(screen.has('YOUR PLACE')).toBe(true);
    expect(screen.labelled('Your place').length).toBeGreaterThan(0);
  });

  it('a reader who is not on the board gets no pinned row', async () => {
    const screen = await open(sources({ board: { rows: [row(1, 'Maya', 8)], you: null } }).all);
    expect(screen.has('YOUR PLACE')).toBe(false);
    expect(screen.rowLabels()).toEqual(['1. Maya, 8 verified']);
  });

  it('shows names and counts only: no device id or other detail appears anywhere', async () => {
    const screen = await open(sources({ board: { rows: [row(1, 'Maya', 8)], you: row(1, 'Maya', 8, true) } }).all);
    expect(JSON.stringify(screen.renderer.toJSON())).not.toContain(DEVICE);
  });
});

describe('LeaderboardScreen: states', () => {
  it('shows a spinner while the board loads, then the rows', async () => {
    let release!: (b: LeaderboardResponse) => void;
    const api: LeaderboardApi = { postVerification: async () => 'sent', getLeaderboard: () => new Promise((resolve) => (release = resolve)) };
    const s = sources();
    const screen = await open({ ...s.all, api });
    expect(screen.spinner()).toBe(1);
    expect(screen.rowLabels()).toEqual([]);
    expect(screen.has("Couldn't load the leaderboard")).toBe(false);
    await act(async () => release({ rows: [row(1, 'Maya', 3)], you: null }));
    expect(screen.spinner()).toBe(0);
    expect(screen.rowLabels()).toEqual(['1. Maya, 3 verified']);
  });

  it('Scenario: Board unavailable - a message says it cannot load, and Retry is offered', async () => {
    const screen = await open(sources({ board: new Error('Network request failed') }).all);
    expect(screen.has("Couldn't load the leaderboard")).toBe(true);
    expect(screen.has('Check your connection and try again. Everything else in the app still works.')).toBe(true);
    expect(screen.renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Retry' && typeof n.props.onPress === 'function').length).toBeGreaterThan(0);
    expect(screen.spinner()).toBe(0);
    expect(screen.rowLabels()).toEqual([]);
  });

  it('Retry loads again and shows the board when the server is back, trying the send again too', async () => {
    const s = sources({ boards: [new Error('offline'), { rows: [row(1, 'Maya', 3)], you: null }] });
    const screen = await open(s.all);
    expect(screen.has("Couldn't load the leaderboard")).toBe(true);
    expect(s.flush).toHaveBeenCalledTimes(1);
    await screen.press('Retry');
    await act(async () => {});
    expect(screen.has("Couldn't load the leaderboard")).toBe(false);
    expect(screen.rowLabels()).toEqual(['1. Maya, 3 verified']);
    expect(s.asked).toHaveLength(2);
    expect(s.flush).toHaveBeenCalledTimes(2);
  });

  it('Retry can fail again, and stays offered', async () => {
    const s = sources({ board: new Error('offline') });
    const screen = await open(s.all);
    await screen.press('Retry');
    await act(async () => {});
    expect(screen.has("Couldn't load the leaderboard")).toBe(true);
    await screen.press('Retry');
    expect(s.asked.length).toBeGreaterThanOrEqual(3);
  });

  it('Scenario: Empty board - "No verified readers yet", with no rows and no list', async () => {
    const screen = await open(sources({ board: { rows: [], you: null } }).all);
    expect(screen.has('No verified readers yet')).toBe(true);
    expect(screen.has("Pass an article's quiz to be the first.")).toBe(true);
    expect(screen.rowLabels()).toEqual([]);
    expect(screen.has('VERIFIED READERS')).toBe(false);
    expect(screen.has("Couldn't load the leaderboard")).toBe(false);
  });

  it('a board with readers does not show the empty message', async () => {
    const screen = await open(sources({ board: { rows: [row(1, 'Maya', 1)], you: null } }).all);
    expect(screen.has('No verified readers yet')).toBe(false);
  });

  it('with the app on mock data the board cannot load, which reads as unavailable and nothing crashes', async () => {
    const screen = await open(sources({ board: new Error('The leaderboard needs the live data source') }).all);
    expect(screen.has("Couldn't load the leaderboard")).toBe(true);
  });
});

describe('LeaderboardScreen: sending what is waiting', () => {
  it('opening the board tries to send what is still queued from this device, once', async () => {
    const s = sources({ board: { rows: [], you: null } });
    await open(s.all);
    expect(s.flush).toHaveBeenCalledTimes(1);
  });

  it('the board does not wait for the send: it shows while the send is still going', async () => {
    const s = sources({ board: { rows: [row(1, 'Maya', 3)], you: null }, flush: () => new Promise(() => {}) });
    const screen = await open(s.all);
    expect(screen.rowLabels()).toEqual(['1. Maya, 3 verified']);
  });

  it('when the send gets something through, the board is fetched again so the reader\'s own count is in it', async () => {
    let finish!: (r: unknown) => void;
    const s = sources({
      boards: [{ rows: [row(1, 'Daniel', 2)], you: null }, { rows: [row(1, 'Daniel', 2), row(2, 'Maya', 1, true)], you: row(2, 'Maya', 1, true) }],
      flush: () => new Promise((resolve) => (finish = resolve)),
    });
    const screen = await open(s.all);
    expect(screen.rowLabels()).toEqual(['1. Daniel, 2 verified']); // first the board as it was
    await act(async () => finish({ sent: 1, rejected: 0, remaining: 0 }));
    await act(async () => {});
    expect(screen.rowLabels()).toEqual(['1. Daniel, 2 verified', '2. Maya, 1 verified, you']);
    expect(s.asked).toHaveLength(2);
  });

  it('when the send gets nothing through, the board is not fetched a second time', async () => {
    for (const result of [{ sent: 0, rejected: 0, remaining: 2 }, { sent: 0, rejected: 1, remaining: 0 }, undefined]) {
      const s = sources({ board: { rows: [row(1, 'Maya', 1)], you: null }, flush: async () => result });
      await open(s.all);
      expect(s.asked).toHaveLength(1);
    }
  });

  it('a send that fails, or a second fetch that fails, leaves the board that is already shown', async () => {
    const failing = sources({ board: { rows: [row(1, 'Maya', 1)], you: null }, flush: async () => { throw new Error('boom'); } });
    expect((await open(failing.all)).rowLabels()).toEqual(['1. Maya, 1 verified']);
    const refetchFails = sources({ boards: [{ rows: [row(1, 'Maya', 1)], you: null }, new Error('offline again')], flush: async () => ({ sent: 1, rejected: 0, remaining: 0 }) });
    const screen = await open(refetchFails.all);
    expect(screen.rowLabels()).toEqual(['1. Maya, 1 verified']);
    expect(screen.has("Couldn't load the leaderboard")).toBe(false);
  });

  it('a queue that throws instead of failing quietly does not stop the board', async () => {
    const s = sources({ board: { rows: [row(1, 'Maya', 1)], you: null } });
    const throwing = { enqueue: jest.fn(), flush: jest.fn(() => { throw new Error('thrown at once'); }) } as unknown as SyncQueue;
    const screen = await open({ ...s.all, sync: throwing });
    expect(throwing.flush).toHaveBeenCalledTimes(1);
    expect(screen.rowLabels()).toEqual(['1. Maya, 1 verified']);
  });
});

describe('LeaderboardScreen: leaving and overlapping loads', () => {
  it('Back goes back, or to Profile when there is nothing to go back to', async () => {
    const screen = await open(sources({ board: { rows: [], you: null } }).all);
    await screen.press('Back');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockRouter.canGoBack.mockReturnValue(false);
    await screen.press('Back');
    expect(mockRouter.replace).toHaveBeenCalledWith('/profile');
  });

  it('closing the screen while the board is still loading changes nothing and raises no error', async () => {
    let release!: (b: LeaderboardResponse) => void;
    const api: LeaderboardApi = { postVerification: async () => 'sent', getLeaderboard: () => new Promise((resolve) => (release = resolve)) };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const screen = await open({ ...sources().all, api });
    await act(async () => screen.renderer.unmount());
    await act(async () => release({ rows: [row(1, 'Late', 1)], you: null }));
    expect(error).not.toHaveBeenCalled();
  });

  it('when Retry is pressed while an earlier load is still out, only the newest answer is used', async () => {
    const pending: Array<(b: LeaderboardResponse | Error) => void> = [];
    const api: LeaderboardApi = { postVerification: async () => 'sent', getLeaderboard: () => new Promise((resolve, reject) => pending.push((b) => (b instanceof Error ? reject(b) : resolve(b)))) };
    const screen = await open({ ...sources().all, api });
    await act(async () => pending[0](new Error('slow failure'))); // the first load fails...
    expect(screen.has("Couldn't load the leaderboard")).toBe(true);
    await screen.press('Retry'); // ...so Retry starts a second
    await act(async () => pending[1]({ rows: [row(1, 'Maya', 1)], you: null }));
    expect(screen.rowLabels()).toEqual(['1. Maya, 1 verified']);
    await act(async () => pending[0]({ rows: [row(1, 'Stale', 9)], you: null })); // the old answer, late
    expect(screen.rowLabels()).toEqual(['1. Maya, 1 verified']);
  });

  it('makes no request other than the board\'s own', async () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    try {
      await open(sources({ board: { rows: [], you: null } }).all);
    } finally {
      global.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled(); // the fake sources are the only way out
  });
});
