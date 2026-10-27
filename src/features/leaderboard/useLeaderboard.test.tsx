import { act, create } from 'react-test-renderer';
import type { DeviceIdRepository, LeaderboardApi, LeaderboardResponse, SyncQueue } from '../../data';
import { useLeaderboard } from './useLeaderboard';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const board = (...names: string[]): LeaderboardResponse => ({ rows: names.map((n, i) => ({ rank: i + 1, display_name: n, count: 1, is_you: false })), you: null });
const names = (b: LeaderboardResponse | null) => b?.rows.map((r) => r.display_name) ?? null;

/** Fetches and sends that stay open until the test finishes them, so overlapping loads can be played out of order. */
function controlled() {
  const fetches: Array<{ ok: (b: LeaderboardResponse) => void; fail: (e: Error) => void }> = [];
  const flushes: Array<(r: { sent: number; rejected: number; remaining: number }) => void> = [];
  const api: LeaderboardApi = {
    postVerification: async () => 'sent',
    getLeaderboard: () => new Promise((ok, fail) => fetches.push({ ok, fail })),
  };
  const device: DeviceIdRepository = { get: async () => 'device', forget: async () => {} };
  const sync = { enqueue: jest.fn(), flush: jest.fn(() => new Promise((resolve) => flushes.push(resolve as never))) } as unknown as SyncQueue;
  return { sources: { api, device, sync }, fetches, flushes };
}

async function mount(c: ReturnType<typeof controlled>) {
  const out = { state: undefined as never as ReturnType<typeof useLeaderboard> };
  function H() {
    out.state = useLeaderboard(c.sources);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<H />);
  });
  await act(async () => {});
  return { out, renderer };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('useLeaderboard', () => {
  it('starts loading, with no board, and becomes ready with it', async () => {
    const c = controlled();
    const { out } = await mount(c);
    expect([out.state.status, out.state.board]).toEqual(['loading', null]);
    await act(async () => c.fetches[0].ok(board('Maya')));
    expect(out.state.status).toBe('ready');
    expect(names(out.state.board)).toEqual(['Maya']);
  });

  it('becomes error when the board cannot be loaded, and keeps no board', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => c.fetches[0].fail(new Error('offline')));
    expect([out.state.status, out.state.board]).toEqual(['error', null]);
  });

  it('retry shows loading again at once, and then the new answer', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => c.fetches[0].fail(new Error('offline')));
    await act(async () => out.state.retry());
    expect(out.state.status).toBe('loading');
    await act(async () => c.fetches[1].ok(board('Maya')));
    expect(out.state.status).toBe('ready');
  });

  it('Retry while a load is still out: the newest answer wins, and a late answer from the older one is ignored', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => out.state.retry()); // a second load starts while the first is out
    await act(async () => c.fetches[1].ok(board('Fresh')));
    await act(async () => c.fetches[0].ok(board('Stale')));
    expect(names(out.state.board)).toEqual(['Fresh']);
    expect(out.state.status).toBe('ready');
  });

  it('a late failure from an older load does not turn a good board into an error', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => out.state.retry());
    await act(async () => c.fetches[1].ok(board('Fresh')));
    await act(async () => c.fetches[0].fail(new Error('late failure')));
    expect(out.state.status).toBe('ready');
    expect(names(out.state.board)).toEqual(['Fresh']);
  });

  it('a send that finishes for an older load does not fetch again or replace the board', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => out.state.retry());
    await act(async () => c.fetches[1].ok(board('Fresh')));
    const before = c.fetches.length;
    await act(async () => c.flushes[0]({ sent: 1, rejected: 0, remaining: 0 })); // the first load's send, after a retry
    expect(c.fetches.length).toBe(before);
    expect(names(out.state.board)).toEqual(['Fresh']);
  });

  it('a send that finishes for the current load does fetch again, and updates the board', async () => {
    const c = controlled();
    const { out } = await mount(c);
    await act(async () => c.fetches[0].ok(board('Maya')));
    await act(async () => c.flushes[0]({ sent: 2, rejected: 0, remaining: 0 }));
    expect(c.fetches).toHaveLength(2);
    await act(async () => c.fetches[1].ok(board('Maya', 'Daniel')));
    expect(names(out.state.board)).toEqual(['Maya', 'Daniel']);
    expect(out.state.status).toBe('ready');
  });

  it('each load sends once, and a retry sends again', async () => {
    const c = controlled();
    const { out } = await mount(c);
    expect(c.sources.sync.flush).toHaveBeenCalledTimes(1);
    await act(async () => out.state.retry());
    expect(c.sources.sync.flush).toHaveBeenCalledTimes(2);
  });

  it('leaving while loading ignores the answer', async () => {
    const c = controlled();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { out, renderer } = await mount(c);
    await act(async () => renderer.unmount());
    await act(async () => c.fetches[0].ok(board('Late')));
    expect(out.state.board).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});
