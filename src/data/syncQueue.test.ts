import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LeaderboardApi, PostResult } from './repository';
import { createSyncQueue, FALLBACK_NAME, leaderboardName } from './syncQueue';
import type { SyncVerification } from './types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const KEY = 'swipy:verify_outbox';
const DEVICE = '3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a90';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const stored = async () => JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null');

// The storage mock is shared, so its behaviour is changed and put back explicitly (restoring a spy would wipe it).
const realGetItem = (AsyncStorage.getItem as jest.Mock).getMockImplementation()!;
const realSetItem = (AsyncStorage.setItem as jest.Mock).getMockImplementation()!;
const restoreStore = () => {
  (AsyncStorage.getItem as jest.Mock).mockReset().mockImplementation(realGetItem);
  (AsyncStorage.setItem as jest.Mock).mockReset().mockImplementation(realSetItem);
};
const failReads = () => (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => { throw new Error('disk error'); });
const failWrites = (when: (key: string, value: string) => boolean = () => true) =>
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    if (when(key, value)) throw new Error('storage full');
    return realSetItem(key, value);
  });
const writes = () => (AsyncStorage.setItem as jest.Mock).mock.calls.filter(([key]: [string]) => key === KEY);

/** A server that answers from a script (the last answer repeats) and records what it was sent. */
function fakeServer(...answers: PostResult[]) {
  const sent: SyncVerification[] = [];
  const api: LeaderboardApi = {
    postVerification: async (v) => {
      sent.push(v);
      return answers[Math.min(sent.length - 1, answers.length - 1)] ?? 'sent';
    },
    getLeaderboard: async () => ({ rows: [], you: null }),
  };
  return { api, sent };
}
/** A server whose answer can be changed between flushes, as when the network goes and comes back. */
function switchableServer(initial: PostResult) {
  let answer = initial;
  const sent: SyncVerification[] = [];
  const api: LeaderboardApi = { postVerification: async (v) => (sent.push(v), answer), getLeaderboard: async () => ({ rows: [], you: null }) };
  return { api, sent, set: (a: PostResult) => (answer = a) };
}

let profileName: string | null | undefined = 'Maya Chen';
// A new queue over the same storage stands in for an app restart.
const open = (api: LeaderboardApi, extra: Partial<Parameters<typeof createSyncQueue>[0]> = {}) =>
  createSyncQueue({ storage: AsyncStorage, api, getDeviceId: async () => DEVICE, getDisplayName: async () => profileName, now: () => NOW, ...extra });

beforeEach(async () => {
  await AsyncStorage.clear();
  profileName = 'Maya Chen';
  restoreStore();
});

describe('leaderboardName', () => {
  it('uses the profile name, or "Reader" when there is none', () => {
    expect(leaderboardName('Maya Chen')).toBe('Maya Chen');
    for (const none of [undefined, null, '', '   ', '\n\t']) expect(leaderboardName(none)).toBe(FALLBACK_NAME);
    expect(FALLBACK_NAME).toBe('Reader');
  });

  it('cleans it to what the server accepts: no control characters, tidy spaces, 40 characters at most', () => {
    expect(leaderboardName('  Maya \n Chen  ')).toBe('Maya Chen');
    expect(leaderboardName('tab\there')).toBe('tab here');
    expect(leaderboardName('\u0000\u0007')).toBe('Reader');
    expect(leaderboardName('x'.repeat(60))).toBe('x'.repeat(40));
    expect(leaderboardName('🙂'.repeat(50))).toBe('🙂'.repeat(40)); // characters, not UTF-16 units
    expect(leaderboardName(`${'x'.repeat(39)} y`)).toBe(`${'x'.repeat(39)} y`.slice(0, 40).trim());
    expect(leaderboardName('Zoë Ünal')).toBe('Zoë Ünal');
  });
});

describe('sync queue: saving', () => {
  it('enqueue writes the verification to the device under swipy:verify_outbox, without sending anything', async () => {
    const { api, sent } = fakeServer();
    await open(api).enqueue('a1', '2026-10-06T11:00:00.000Z');
    expect(await stored()).toEqual([{ article_id: 'a1', verified_at: '2026-10-06T11:00:00.000Z' }]);
    expect(sent).toEqual([]);
  });

  it('uses the current time when none is given', async () => {
    await open(fakeServer().api).enqueue('a1');
    expect(await stored()).toEqual([{ article_id: 'a1', verified_at: NOW.toISOString() }]);
  });

  it('keeps verifications in the order they were made', async () => {
    const q = open(fakeServer().api);
    await q.enqueue('a1', '2026-10-06T10:00:00.000Z');
    await q.enqueue('a2', '2026-10-06T10:05:00.000Z');
    await q.enqueue('a3', '2026-10-06T10:10:00.000Z');
    expect((await stored()).map((i: { article_id: string }) => i.article_id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('Scenario: No double counting - the same article queued twice is queued once, with its first time', async () => {
    const q = open(fakeServer().api);
    await q.enqueue('a1', '2026-10-06T10:00:00.000Z');
    await q.enqueue('a1', '2026-10-06T11:00:00.000Z');
    expect(await stored()).toEqual([{ article_id: 'a1', verified_at: '2026-10-06T10:00:00.000Z' }]);
  });

  it('two enqueues at the same moment both land', async () => {
    const q = open(fakeServer().api);
    await Promise.all([q.enqueue('a1', '2026-10-06T10:00:00.000Z'), q.enqueue('a2', '2026-10-06T10:00:01.000Z'), q.enqueue('a1', '2026-10-06T10:00:02.000Z')]);
    expect((await stored()).map((i: { article_id: string }) => i.article_id).sort()).toEqual(['a1', 'a2']);
  });

  it('enqueue never waits for the network', async () => {
    let called = false;
    const slow: LeaderboardApi = { postVerification: () => ((called = true), new Promise<PostResult>(() => {})), getLeaderboard: async () => ({ rows: [], you: null }) };
    await open(slow).enqueue('a1');
    expect(called).toBe(false);
  });
});

describe('sync queue: sending', () => {
  it('sends what is waiting with the device id, the current profile name, and the time it was verified', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    await q.enqueue('a1', '2026-10-06T10:00:00.000Z');
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(sent).toEqual([{ device_id: DEVICE, display_name: 'Maya Chen', article_id: 'a1', verified_at: '2026-10-06T10:00:00.000Z' }]);
    expect(await stored()).toEqual([]); // and it is no longer waiting
  });

  it('with nothing waiting, flush does nothing and asks for nothing', async () => {
    const { api, sent } = fakeServer();
    const getDeviceId = jest.fn(async () => DEVICE);
    expect(await open(api, { getDeviceId }).flush()).toEqual({ sent: 0, rejected: 0, remaining: 0 });
    expect(sent).toEqual([]);
    expect(getDeviceId).not.toHaveBeenCalled();
  });

  it('Scenario: Offline queue - two verifications made with no network are both sent, once, in order, when it returns', async () => {
    const server = switchableServer('retry'); // offline
    const q = open(server.api);
    await q.enqueue('a1', '2026-10-06T10:00:00.000Z');
    await q.enqueue('a2', '2026-10-06T10:05:00.000Z');
    expect(await q.flush()).toEqual({ sent: 0, rejected: 0, remaining: 2 });
    expect((await stored()).length).toBe(2); // still waiting
    server.sent.length = 0;
    server.set('sent'); // the network returns
    expect(await q.flush()).toEqual({ sent: 2, rejected: 0, remaining: 0 });
    expect(server.sent.map((v) => v.article_id)).toEqual(['a1', 'a2']);
    expect(await stored()).toEqual([]);
    expect(await q.flush()).toEqual({ sent: 0, rejected: 0, remaining: 0 });
    expect(server.sent).toHaveLength(2); // and nothing goes again
  });

  it('stops at the first one the server cannot take, so the order is kept', async () => {
    const { api, sent } = fakeServer('sent', 'retry', 'sent');
    const q = open(api);
    for (const id of ['a1', 'a2', 'a3']) await q.enqueue(id, '2026-10-06T10:00:00.000Z');
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 2 });
    expect(sent.map((v) => v.article_id)).toEqual(['a1', 'a2']); // a3 was not tried
    expect((await stored()).map((i: { article_id: string }) => i.article_id)).toEqual(['a2', 'a3']);
  });

  it('Scenario: Retry - the next flush carries on from where it stopped', async () => {
    const server = switchableServer('sent');
    let calls = 0;
    const api: LeaderboardApi = { postVerification: async (v) => (server.sent.push(v), ++calls === 2 ? 'retry' : 'sent'), getLeaderboard: async () => ({ rows: [], you: null }) };
    const q = open(api);
    for (const id of ['a1', 'a2', 'a3']) await q.enqueue(id);
    await q.flush(); // a1 sent, a2 refused for now
    server.sent.length = 0;
    expect(await q.flush()).toEqual({ sent: 2, rejected: 0, remaining: 0 });
    expect(server.sent.map((v) => v.article_id)).toEqual(['a2', 'a3']);
  });

  it('a verification the server will never accept is dropped, and the ones behind it still go', async () => {
    const { api, sent } = fakeServer('sent', 'rejected', 'sent');
    const q = open(api);
    for (const id of ['a1', 'mock-1', 'a3']) await q.enqueue(id);
    expect(await q.flush()).toEqual({ sent: 2, rejected: 1, remaining: 0 });
    expect(sent.map((v) => v.article_id)).toEqual(['a1', 'mock-1', 'a3']);
    expect(await stored()).toEqual([]);
  });

  it('a rejected one at the front does not hold up the rest, even when the server is then offline', async () => {
    const { api } = fakeServer('rejected', 'retry');
    const q = open(api);
    for (const id of ['bad', 'a2']) await q.enqueue(id);
    expect(await q.flush()).toEqual({ sent: 0, rejected: 1, remaining: 1 });
    expect((await stored()).map((i: { article_id: string }) => i.article_id)).toEqual(['a2']);
  });

  it('Scenario: Restart with a pending item - a new queue after the app was closed sends it', async () => {
    const offline = switchableServer('retry');
    const first = open(offline.api);
    await first.enqueue('a1', '2026-10-06T10:00:00.000Z');
    await first.flush(); // could not send, and then the app is closed
    const online = fakeServer('sent');
    const second = open(online.api); // the next launch
    expect(await second.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(online.sent).toEqual([{ device_id: DEVICE, display_name: 'Maya Chen', article_id: 'a1', verified_at: '2026-10-06T10:00:00.000Z' }]);
    expect(await stored()).toEqual([]);
  });

  it('a verification queued but never flushed is still there after a restart', async () => {
    await open(fakeServer().api).enqueue('a1', '2026-10-06T10:00:00.000Z');
    const { api, sent } = fakeServer('sent');
    await open(api).flush();
    expect(sent.map((v) => v.article_id)).toEqual(['a1']);
  });

  it('a rename reaches the board: the name sent is the one in the profile when it is sent, not when it was verified', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    profileName = 'Old name';
    await q.enqueue('a1');
    profileName = 'New name';
    await q.flush();
    expect(sent[0].display_name).toBe('New name');
  });

  it('with no profile name it sends "Reader", and a profile that cannot be read does not stop the send', async () => {
    const { api, sent } = fakeServer('sent');
    profileName = undefined;
    const q = open(api);
    await q.enqueue('a1');
    await q.flush();
    expect(sent[0].display_name).toBe('Reader');
    const again = fakeServer('sent');
    const failing = open(again.api, { getDisplayName: async () => { throw new Error('profile unreadable'); } });
    await failing.enqueue('a2');
    await failing.flush();
    expect(again.sent[0].display_name).toBe('Reader');
  });

  it('a send that throws, or a device id that cannot be made, leaves the verification waiting', async () => {
    const throwing: LeaderboardApi = { postVerification: async () => { throw new Error('boom'); }, getLeaderboard: async () => ({ rows: [], you: null }) };
    const q = open(throwing);
    await q.enqueue('a1');
    await expect(q.flush()).resolves.toEqual({ sent: 0, rejected: 0, remaining: 1 });
    const noId = open(fakeServer('sent').api, { getDeviceId: async () => { throw new Error('no id'); } });
    await expect(noId.flush()).resolves.toEqual({ sent: 0, rejected: 0, remaining: 1 });
    expect((await stored()).length).toBe(1);
  });

  it('two flushes at once make one run: nothing is sent twice', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    for (const id of ['a1', 'a2']) await q.enqueue(id);
    const [x, y] = await Promise.all([q.flush(), q.flush()]);
    expect(x).toBe(y);
    expect(sent.map((v) => v.article_id)).toEqual(['a1', 'a2']);
  });

  it('a flush after one has finished runs again', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    await q.enqueue('a1');
    await q.flush();
    await q.enqueue('a2');
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(sent.map((v) => v.article_id)).toEqual(['a1', 'a2']);
  });

  it('a verification queued while a send is under way is not lost, and is sent once', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api: LeaderboardApi = {
      postVerification: async (v) => {
        sent.push(v.article_id);
        if (v.article_id === 'a1') await gate;
        return 'sent';
      },
      getLeaderboard: async () => ({ rows: [], you: null }),
    };
    const q = open(api);
    await q.enqueue('a1');
    const running = q.flush();
    await new Promise((r) => setTimeout(r, 10));
    await q.enqueue('a2'); // while a1 is still on its way
    release();
    await running;
    await q.flush();
    expect(sent).toEqual(['a1', 'a2']);
    expect(await stored()).toEqual([]);
  });

  it('Scenario: sent twice - if the app closes after a send but before the removal, it goes again and the server counts it once', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    await q.enqueue('a1');
    failWrites((key, value) => key === KEY && value === '[]'); // the removal cannot be saved
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 }); // this run does not loop on it
    expect(sent).toHaveLength(1);
    expect((await stored()).length).toBe(1); // still saved as waiting
    restoreStore();
    await open(api).flush(); // the next launch sends it again
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]); // exactly the same verification, which the server counts once
    expect(await stored()).toEqual([]);
  });
});

describe('sync queue: when the device store misbehaves', () => {
  it('a store that cannot be read: enqueue does not throw, and the verification is sent from memory', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    failReads();
    await expect(q.enqueue('a1')).resolves.toBeUndefined();
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(sent.map((v) => v.article_id)).toEqual(['a1']);
  });

  it('nothing is written over a store that could not be read', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([{ article_id: 'old', verified_at: '2026-10-06T09:00:00.000Z' }]));
    const q = open(fakeServer('retry').api);
    failReads();
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await q.enqueue('new');
    await q.flush();
    expect(writes()).toEqual([]); // nothing written to the outbox
    restoreStore();
    expect((await stored()).map((i: { article_id: string }) => i.article_id)).toEqual(['old']); // the saved one is untouched
  });

  it('what was held back is saved, behind what was already there, once the store can be read again', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([{ article_id: 'old', verified_at: '2026-10-06T09:00:00.000Z' }]));
    const q = open(fakeServer('retry').api);
    failReads();
    await q.enqueue('new', '2026-10-06T10:00:00.000Z');
    restoreStore();
    await q.flush(); // retry: nothing leaves, but the queue is read and merged
    expect(await stored()).toEqual([
      { article_id: 'old', verified_at: '2026-10-06T09:00:00.000Z' },
      { article_id: 'new', verified_at: '2026-10-06T10:00:00.000Z' },
    ]);
  });

  it('an item held back and also found saved is not listed twice when they are merged', async () => {
    const q = open(fakeServer('retry').api);
    failReads();
    await q.enqueue('a1', '2026-10-06T10:00:00.000Z'); // held back in memory
    restoreStore();
    await AsyncStorage.setItem(KEY, JSON.stringify([{ article_id: 'a1', verified_at: '2026-10-06T09:00:00.000Z' }, { article_id: 'a2', verified_at: '2026-10-06T09:30:00.000Z' }]));
    await q.flush();
    expect(await stored()).toEqual([
      { article_id: 'a1', verified_at: '2026-10-06T09:00:00.000Z' }, // the saved one, with its own time
      { article_id: 'a2', verified_at: '2026-10-06T09:30:00.000Z' },
    ]);
  });

  it('a write that fails keeps the verification for this run, and a later flush still sends it', async () => {
    const { api, sent } = fakeServer('sent');
    const q = open(api);
    failWrites();
    await q.enqueue('a1');
    restoreStore();
    expect(await q.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
    expect(sent.map((v) => v.article_id)).toEqual(['a1']);
  });

  it('a damaged outbox (not JSON, or not a list) is treated as empty and replaced', async () => {
    for (const garbage of ['not json {', '{"a":1}', '"text"', '7', 'null']) {
      await AsyncStorage.setItem(KEY, garbage);
      const q = open(fakeServer().api);
      await q.enqueue('a1', '2026-10-06T10:00:00.000Z');
      expect(await stored()).toEqual([{ article_id: 'a1', verified_at: '2026-10-06T10:00:00.000Z' }]);
    }
  });

  it('damaged entries in a good list are dropped and the rest are kept', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([{ article_id: 'ok', verified_at: '2026-10-06T09:00:00.000Z' }, { article_id: 5 }, 'junk', null, { verified_at: 'x' }]));
    const { api, sent } = fakeServer('sent');
    await open(api).flush();
    expect(sent.map((v) => v.article_id)).toEqual(['ok']);
  });

  it('flush never rejects, whatever the store and the server do', async () => {
    const q = open({ postVerification: async () => { throw new Error('x'); }, getLeaderboard: async () => ({ rows: [], you: null }) });
    failReads();
    await expect(q.flush()).resolves.toEqual({ sent: 0, rejected: 0, remaining: 0 });
  });
});

describe('sync queue: scope', () => {
  it('stores only the article id and the time: no name, no device id, nothing about the reader', async () => {
    await open(fakeServer().api).enqueue('a1', '2026-10-06T10:00:00.000Z');
    const text = (await AsyncStorage.getItem(KEY)) ?? '';
    expect(text).not.toContain('Maya');
    expect(text).not.toContain(DEVICE);
  });
});

describe('clear (account deletion)', () => {
  it('drops everything waiting to be sent, so a deleted leaderboard entry is not recreated by a later send', async () => {
    const { api, sent } = switchableServer('sent' as PostResult);
    const queue = open(api);
    await queue.enqueue('article-1');
    await queue.clear();
    expect(await AsyncStorage.getItem('swipy:verify_outbox')).toBeNull();
    expect(await queue.flush()).toEqual({ sent: 0, rejected: 0, remaining: 0 });
    expect(sent).toEqual([]);
  });
});

describe('hold (account deletion)', () => {
  it('waits for a send that is already under way, so none can reach the server after the delete', async () => {
    let finishPost!: () => void;
    const sent: string[] = [];
    const api: LeaderboardApi = {
      postVerification: (v) => new Promise((resolve) => { finishPost = () => (sent.push(v.article_id), resolve('sent')); }),
      getLeaderboard: async () => ({ rows: [], you: null }),
    };
    const queue = open(api);
    await queue.enqueue('article-1');
    void queue.flush();
    await new Promise((r) => setTimeout(r, 0)); // the post is now in flight
    let held = false;
    const holding = queue.hold().then((release) => { held = true; return release; });
    await new Promise((r) => setTimeout(r, 10));
    expect(held).toBe(false); // still waiting for the post in flight
    finishPost();
    const release = await holding;
    expect(sent).toEqual(['article-1']); // that one reached the server before the delete could start
    release();
  });

  it('while held, a flush sends nothing and reports what is waiting; after release it sends again', async () => {
    const { api, sent } = switchableServer('sent' as PostResult);
    const queue = open(api);
    await queue.enqueue('article-1');
    const release = await queue.hold();
    expect(await queue.flush()).toEqual({ sent: 0, rejected: 0, remaining: 1 });
    expect(sent).toEqual([]);
    release();
    expect(await queue.flush()).toEqual({ sent: 1, rejected: 0, remaining: 0 });
  });

  it('a verification queued while held waits and is sent after release', async () => {
    const { api, sent } = switchableServer('sent' as PostResult);
    const queue = open(api);
    const release = await queue.hold();
    await queue.enqueue('article-2');
    await queue.flush();
    expect(sent).toEqual([]);
    release();
    await queue.flush();
    expect(sent.map((v) => v.article_id)).toEqual(['article-2']);
  });

  it('a flush that was waiting at the moment of the hold does not send either', async () => {
    const { api, sent } = switchableServer('sent' as PostResult);
    const queue = open(api);
    await queue.enqueue('article-1');
    const flushing = queue.flush(); // started before the hold
    const release = await queue.hold();
    await flushing;
    await queue.clear(); // the delete went through
    release();
    await queue.flush();
    expect(sent.length).toBeLessThanOrEqual(1); // at most the one already on its way; never one after the clear
    const after = sent.length;
    await queue.flush();
    expect(sent.length).toBe(after);
  });
});
