import { createAccountSync, SYNC_STATE_KEY, type AccountSync, type SyncTimers } from './accountSync';
import { MIGRATE_KEY } from './scopedStorage';
import type { AccountApi, AccountResult, SyncAnswer, SyncChanges, SyncListItem, SyncProfile } from './accountApi';
import { createLocalStore, type KeyValueStorage, type LocalStore } from './localStore';
import { createVerifiedRepository, type VerifiedRepository } from './verifiedRepository';
import type { SwipeEvent, VerifiedRecord } from './types';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const USER = 'local-user';
const T0 = Date.parse('2026-10-10T12:00:00.000Z'); // only for the verified records' own clock
/** Real times, because the engine stamps removals and profile saves with the real clock. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

// ---- a stand-in for the server: the same merge rules, in memory --------------------------------------

class FakeServer {
  rev = 0;
  profile: (SyncProfile & { rev: number }) | null = null;
  list = new Map<string, SyncListItem & { rev: number }>();
  verified = new Map<string, VerifiedRecord & { rev: number }>();
  skips: string[] = [];
  calls: Array<{ cursor: number; changes: SyncChanges }> = [];
  skipCalls: string[][] = [];
  /** Old leaderboard entries by device number, as the server holds them before they are claimed. */
  deviceRows = new Map<string, VerifiedRecord[]>();
  claims: Array<{ deviceId: string; uploadedBefore: boolean }> = [];
  claimScript: Array<AccountResult<never> | 'drop'> = [];
  /** Answers to give instead of the real one, in order. */
  script: Array<AccountResult<never> | 'drop'> = [];

  api: AccountApi = {
    sync: async (_token, cursor, changes) => {
      this.calls.push({ cursor, changes: JSON.parse(JSON.stringify(changes)) });
      const scripted = this.script.shift();
      if (scripted && scripted !== 'drop') return scripted;
      if (scripted === 'drop') return { kind: 'failed' };
      if (changes.profile && (!this.profile || Date.parse(changes.profile.updated_at) > Date.parse(this.profile.updated_at))) this.profile = { ...changes.profile, rev: ++this.rev };
      for (const c of changes.reading_list ?? []) {
        const mine = this.list.get(c.article_id);
        if (!mine || Date.parse(c.updated_at) > Date.parse(mine.updated_at)) this.list.set(c.article_id, { ...c, rev: ++this.rev });
      }
      for (const v of changes.verified ?? []) {
        const mine = this.verified.get(v.article_id);
        if (!mine || Date.parse(v.verified_at) < Date.parse(mine.verified_at)) this.verified.set(v.article_id, { ...v, rev: ++this.rev });
      }
      const strip = <T extends { rev: number }>({ rev: _rev, ...rest }: T) => rest;
      const answer: SyncAnswer = {
        cursor: this.rev,
        changes: {
          profile: this.profile && this.profile.rev > cursor ? (strip(this.profile) as SyncProfile) : null,
          reading_list: [...this.list.values()].filter((i) => i.rev > cursor).map((i) => strip(i) as SyncListItem),
          verified: [...this.verified.values()].filter((i) => i.rev > cursor).map((i) => strip(i) as VerifiedRecord),
        },
      };
      return { kind: 'ok', value: answer };
    },
    skips: async (_token, ids) => {
      this.skipCalls.push(ids);
      const scripted = this.script.shift();
      if (scripted && scripted !== 'drop') return scripted;
      if (scripted === 'drop') return { kind: 'failed' };
      this.skips.push(...ids);
      return { kind: 'ok', value: null };
    },
    claimDevice: async (_token, deviceId) => {
      this.claims.push({ deviceId, uploadedBefore: this.uploaded() });
      const scripted = this.claimScript.shift();
      if (scripted && scripted !== 'drop') return scripted;
      if (scripted === 'drop') return { kind: 'failed' };
      const rows = this.deviceRows.get(deviceId) ?? [];
      this.deviceRows.delete(deviceId);
      for (const v of rows) {
        const mine = this.verified.get(v.article_id);
        if (!mine || Date.parse(v.verified_at) < Date.parse(mine.verified_at)) this.verified.set(v.article_id, { ...v, rev: ++this.rev });
      }
      return { kind: 'ok', value: { folded: rows.length } };
    },
  };
  /** Anything uploaded at all, apart from empty requests. */
  uploaded = () => this.calls.some((c) => c.changes.profile || c.changes.reading_list?.length || c.changes.verified?.length);
}

// ---- a phone: its own storage, local store, verified records and engine -----------------------------

function memoryStorage(): KeyValueStorage & { removeItem(k: string): Promise<void>; dump(): Record<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
    dump: () => Object.fromEntries(data),
  };
}
function manualTimers() {
  const after: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const every: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers: SyncTimers = {
    after: (fn, ms) => { const t = { fn, ms, live: true }; after.push(t); return () => { t.live = false; }; },
    every: (fn, ms) => { const t = { fn, ms, live: true }; every.push(t); return () => { t.live = false; }; },
  };
  return { timers, pending: () => after.filter((t) => t.live), fire: () => { const due = after.filter((t) => t.live); due.forEach((t) => { t.live = false; t.fn(); }); }, tick: () => every.filter((t) => t.live).forEach((t) => t.fn()), every };
}
function phone(server: FakeServer, options: { token?: string | null; deviceId?: string; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = options.storage ?? memoryStorage();
  const local: LocalStore = createLocalStore(storage);
  const verified: VerifiedRepository = createVerifiedRepository(storage, () => new Date(T0));
  const clock = manualTimers();
  const refused: Array<401 | 403> = [];
  const engine: AccountSync = createAccountSync({
    storage, local, verified, api: server.api, userId: USER, now: () => new Date(),
    getToken: async () => (options.token === undefined ? 'token' : options.token),
    getDeviceId: async () => options.deviceId ?? 'device-1',
    onRefused: (status) => refused.push(status), timers: clock.timers,
  });
  return { storage, local, verified, engine, clock, refused, list: async () => (await local.list(USER)).map((i) => i.article_id).sort() };
}
const profileOf = (name: string) => ({ display_name: name, industry: 'Software' as const, interests: ['Cloud'] });
const swipe = (article_id: string, direction: 'left' | 'right'): SwipeEvent => ({ user_id: USER, article_id, direction, swiped_at: ago(0) });

// ---- when syncing starts -----------------------------------------------------------------------------

describe('account sync: when it starts', () => {
  it('Scenario: Nothing is uploaded before the first profile or verification, however much is on the phone', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.local.saveProfile(profileOf('Maya')); // saved before the engine started: not an event
    await p.local.add(USER, 'a');
    await p.engine.start();
    await p.local.add(USER, 'b');
    await p.engine.syncNow();
    expect(server.uploaded()).toBe(false);
    expect(p.engine.enabled()).toBe(false);
  });

  it('Scenario: Saving the profile starts syncing, and the reading list that was already there goes up with it', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.add(USER, 'a');
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    expect(p.engine.enabled()).toBe(true);
    expect(server.profile?.display_name).toBe('Maya');
    expect([...server.list.keys()]).toEqual(['a']);
  });

  it('Scenario: The first verification starts syncing', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.verified.add('a', 'Cloud');
    await p.engine.syncNow();
    expect(p.engine.enabled()).toBe(true);
    expect([...server.verified.keys()]).toEqual(['a']);
  });

  it('saving things in the reading list never starts syncing by itself', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.add(USER, 'a');
    await p.local.remove(USER, 'a');
    await p.engine.syncNow();
    expect(p.engine.enabled()).toBe(false);
    expect(server.uploaded()).toBe(false);
    expect(p.clock.pending()).toHaveLength(0);
  });

  it('the state is kept: after a restart it is still syncing, and sends only what is new', async () => {
    const server = new FakeServer();
    const first = phone(server);
    await first.engine.start();
    await first.local.saveProfile(profileOf('Maya'));
    await first.engine.syncNow();
    await first.local.add(USER, 'a');
    first.clock.fire();
    await first.engine.syncNow();
    first.engine.stop();
    const before = server.calls.length;
    const second = phone(server, { storage: first.storage });
    await second.engine.start();
    expect(second.engine.enabled()).toBe(true);
    expect(server.calls.length).toBe(before + 1); // one pull
    expect(server.calls[before].changes).toEqual({}); // nothing re-uploaded
    expect(JSON.parse(first.storage.dump()[SYNC_STATE_KEY]).cursor).toBe(server.rev);
  });
});

// ---- a new phone -------------------------------------------------------------------------------------

describe('account sync: a new phone', () => {
  async function seededServer() {
    const server = new FakeServer();
    const old = phone(server);
    await old.engine.start();
    await old.local.saveProfile(profileOf('Maya'));
    await old.engine.syncNow(); // the sync that saving the profile started
    await old.local.add(USER, 'a');
    await old.local.add(USER, 'b');
    await old.verified.add('a', 'Cloud');
    old.clock.fire();
    await old.engine.syncNow();
    old.engine.stop();
    return server;
  }

  it('Scenario: Signing in on an empty phone brings everything back, with no upload', async () => {
    const server = await seededServer();
    const fresh = phone(server);
    const uploadsBefore = server.rev;
    await fresh.engine.start();
    expect(fresh.engine.enabled()).toBe(true); // the account was already syncing
    expect(await fresh.local.getProfile()).toEqual(profileOf('Maya'));
    expect(await fresh.list()).toEqual(['a', 'b']);
    expect((await fresh.verified.list()).map((r) => r.article_id)).toEqual(['a']);
    expect(server.rev).toBe(uploadsBefore); // nothing was written back
  });

  it('what came from the server does not count as the reader\'s own actions', async () => {
    const server = await seededServer();
    const fresh = phone(server);
    await fresh.engine.start();
    await fresh.engine.syncNow();
    expect(server.calls.slice(-1)[0].changes).toEqual({});
    expect(fresh.clock.pending()).toHaveLength(0);
  });

  it('an account with nothing on the server stays off', async () => {
    const server = new FakeServer();
    const fresh = phone(server);
    await fresh.engine.start();
    expect(fresh.engine.enabled()).toBe(false);
  });
});

// ---- two phones --------------------------------------------------------------------------------------

describe('account sync: two phones', () => {
  async function pair() {
    const server = new FakeServer();
    const a = phone(server);
    const b = phone(server);
    await a.engine.start();
    await b.engine.start();
    await a.local.saveProfile(profileOf('Maya'));
    await a.engine.syncNow();
    await b.engine.syncNow(); // b learns the account is syncing and takes the profile
    return { server, a, b };
  }

  it('Scenario: A removal on one phone reaches the other', async () => {
    const { a, b } = await pair();
    await a.local.add(USER, 'x');
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(await b.list()).toEqual(['x']);
    await a.local.remove(USER, 'x');
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(await b.list()).toEqual([]);
  });

  it('Scenario: Different changes on each phone end up as one list on both', async () => {
    const { a, b } = await pair();
    await a.local.add(USER, 'from-a');
    await b.local.add(USER, 'from-b');
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(await a.list()).toEqual(['from-a', 'from-b']);
    expect(await b.list()).toEqual(['from-a', 'from-b']);
  });

  it('a removal is stamped after the save it removes, even when this phone\'s clock is behind the one that saved it', async () => {
    const { server, a } = await pair();
    await a.local.putSaved(USER, 'x', later(120)); // saved, on a phone whose clock runs two hours fast
    await a.engine.syncNow();
    await a.local.remove(USER, 'x');
    await a.engine.syncNow();
    expect(server.list.get('x')?.removed).toBe(true);
  });

  it('Scenario: Saving again after the other phone removed it wins, because it is later', async () => {
    const { a, b } = await pair();
    await a.local.putSaved(USER, 'x', ago(60));
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.local.remove(USER, 'x'); // removed "now"
    await a.engine.syncNow();
    await b.local.remove(USER, 'x'); // b, not having heard yet, removes it and saves it again, later than a's removal
    await b.local.putSaved(USER, 'x', later(5));
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(await a.list()).toEqual(['x']);
    expect(await b.list()).toEqual(['x']);
  });

  it('a badge earned on one phone appears on the other, with its time', async () => {
    const { a, b } = await pair();
    await a.verified.add('quiz-1', 'Agents');
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect((await b.verified.list()).map((r) => [r.article_id, r.topic])).toEqual([['quiz-1', 'Agents']]);
  });

  it('a newer profile from the other phone replaces this one, an older one does not', async () => {
    const { server, a, b } = await pair();
    server.profile = { ...profileOf('Maya Chen'), updated_at: later(60), rev: ++server.rev };
    await b.engine.syncNow();
    expect((await b.local.getProfile())?.display_name).toBe('Maya Chen');
    await a.engine.syncNow();
    expect((await a.local.getProfile())?.display_name).toBe('Maya Chen');
  });
});

// ---- sending and failing -----------------------------------------------------------------------------

describe('account sync: sending', () => {
  async function syncing() {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    return { server, p };
  }

  it('a change is sent after a short wait, once, not on every tap', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    await p.local.add(USER, 'b');
    expect(p.clock.pending()).toHaveLength(1);
    expect(p.clock.pending()[0].ms).toBeGreaterThanOrEqual(1000);
    const before = server.calls.length;
    p.clock.fire();
    await p.engine.syncNow();
    expect(server.calls.length).toBe(before + 1);
    expect([...server.list.keys()].sort()).toEqual(['a', 'b']);
  });

  it('only the changes are sent: a second sync with nothing new sends nothing', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    await p.engine.syncNow();
    await p.engine.syncNow();
    expect(server.calls.slice(-1)[0].changes).toEqual({});
  });

  it('Scenario: Offline - nothing is lost; it is tried again later and then goes through', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    server.script.push('drop');
    await p.engine.syncNow();
    expect(server.list.size).toBe(0);
    expect(p.clock.pending().length).toBeGreaterThan(0); // a retry is scheduled
    p.clock.fire();
    await p.engine.syncNow();
    expect([...server.list.keys()]).toEqual(['a']);
  });

  it('Scenario: The session is gone (401) or not approved any more (403) - the app is told, and nothing is applied', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    server.script.push({ kind: 'unauthorized' });
    await p.engine.syncNow();
    server.script.push({ kind: 'forbidden' });
    await p.engine.syncNow();
    expect(p.refused).toEqual([401, 403]);
    expect(server.list.size).toBe(0);
  });

  it('with no session token it does nothing at all', async () => {
    const server = new FakeServer();
    const p = phone(server, { token: null });
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    expect(server.calls).toHaveLength(0);
  });

  it('a request the server calls invalid does not stop the other kinds of change from going through', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    await p.verified.add('v', 'Cloud');
    server.script.push({ kind: 'invalid' }); // the combined request is refused; the parts are then tried one by one
    await p.engine.syncNow();
    expect([...server.list.keys()]).toEqual(['a']);
    expect([...server.verified.keys()]).toEqual(['v']);
  });

  it('a large first upload goes in requests of at most 200 changes', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    for (let i = 0; i < 450; i++) await p.local.putSaved(USER, `a${i}`, ago(i + 1));
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    expect(server.list.size).toBe(450);
    for (const c of server.calls) expect((c.changes.reading_list?.length ?? 0) + (c.changes.verified?.length ?? 0) + (c.changes.profile ? 1 : 0)).toBeLessThanOrEqual(200);
  });

  it('two syncs asked for at once do not run at once', async () => {
    const { server, p } = await syncing();
    await p.local.add(USER, 'a');
    let inFlight = 0;
    let most = 0;
    const real = server.api.sync;
    server.api.sync = async (...args) => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await real(...args); } finally { inFlight--; } };
    await Promise.all([p.engine.syncNow(), p.engine.syncNow(), p.engine.syncNow()]);
    expect(most).toBe(1);
    expect([...server.list.keys()]).toEqual(['a']);
  });

  it('after stop() nothing the reader does is noticed', async () => {
    const { server, p } = await syncing();
    p.engine.stop();
    await p.local.add(USER, 'a');
    await p.local.saveProfile(profileOf('Someone else'));
    expect(p.clock.pending()).toHaveLength(0);
    expect(server.list.size).toBe(0);
  });
});

// ---- skips -------------------------------------------------------------------------------------------

describe('account sync: skip counts', () => {
  it('Scenario: Counted from sign-in - skips go up although syncing has not started, each swipe once', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    for (const s of [swipe('a', 'left'), swipe('b', 'right'), swipe('a', 'left')]) await p.local.recordSwipe(s);
    await p.engine.flushSkips();
    expect(server.skips).toEqual(['a', 'a']);
    expect(p.engine.enabled()).toBe(false);
    await p.engine.flushSkips();
    expect(server.skipCalls).toHaveLength(1); // nothing new, nothing sent
    await p.local.recordSwipe(swipe('c', 'left'));
    await p.engine.flushSkips();
    expect(server.skips).toEqual(['a', 'a', 'c']);
  });

  it('they go in batches of at most 100', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    for (let i = 0; i < 230; i++) await p.local.recordSwipe(swipe(`a${i % 7}`, 'left'));
    await p.engine.flushSkips();
    expect(server.skipCalls.map((c) => c.length)).toEqual([100, 100, 30]);
    expect(server.skips).toHaveLength(230);
  });

  it('a batch that could not be sent is kept and sent next time, once', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.recordSwipe(swipe('a', 'left'));
    server.script.push('drop');
    await p.engine.flushSkips();
    expect(server.skips).toEqual([]);
    await p.engine.flushSkips();
    expect(server.skips).toEqual(['a']);
  });

  it('the count survives a restart, so nothing is sent twice', async () => {
    const server = new FakeServer();
    const first = phone(server);
    await first.engine.start();
    await first.local.recordSwipe(swipe('a', 'left'));
    await first.engine.flushSkips();
    first.engine.stop();
    const second = phone(server, { storage: first.storage });
    await second.engine.start();
    await second.engine.flushSkips();
    expect(server.skips).toEqual(['a']);
  });

  it('a refusal tells the app and counts nothing as sent; a batch the server calls invalid is dropped so it cannot block the rest', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.recordSwipe(swipe('a', 'left'));
    server.script.push({ kind: 'unauthorized' });
    await p.engine.flushSkips();
    expect(p.refused).toEqual([401]);
    server.script.push({ kind: 'invalid' });
    await p.engine.flushSkips(); // dropped
    await p.local.recordSwipe(swipe('b', 'left'));
    await p.engine.flushSkips();
    expect(server.skips).toEqual(['b']);
  });

  it('the periodic tick sends skips and syncs', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    expect(p.clock.every.length).toBeGreaterThan(0);
    await p.local.recordSwipe(swipe('a', 'left'));
    p.clock.tick();
    await p.engine.flushSkips();
    expect(server.skips).toEqual(['a']);
  });
});

// ---- after a deletion that keeps the data on the phone ----------------------------------------------

describe('account sync: after the account was deleted and the phone kept its data', () => {
  async function detached() {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.local.add(USER, 'a');
    await p.verified.add('v', 'Cloud');
    await p.local.recordSwipe(swipe('s', 'left'));
    await p.engine.syncNow();
    await p.engine.detach();
    const fresh = new FakeServer(); // the account is new and empty
    const again = phone(fresh, { storage: p.storage });
    return { fresh, again };
  }

  it('Scenario: Signing in again does not put the old data back', async () => {
    const { fresh, again } = await detached();
    await again.engine.start();
    await again.engine.syncNow();
    await again.engine.flushSkips();
    expect(again.engine.enabled()).toBe(false);
    expect(fresh.uploaded()).toBe(false);
    expect(fresh.skips).toEqual([]); // not even the skips from before
  });

  it('the reading list alone does not start it again', async () => {
    const { fresh, again } = await detached();
    await again.engine.start();
    await again.local.add(USER, 'new');
    await again.engine.syncNow();
    expect(fresh.uploaded()).toBe(false);
  });

  it('Scenario: A new profile save or a new verification starts it again, and then everything is uploaded', async () => {
    const { fresh, again } = await detached();
    await again.engine.start();
    await again.local.saveProfile(profileOf('Maya C'));
    await again.engine.syncNow();
    expect(again.engine.enabled()).toBe(true);
    expect(fresh.profile?.display_name).toBe('Maya C');
    expect([...fresh.list.keys()]).toEqual(['a']);
    expect([...fresh.verified.keys()]).toEqual(['v']);
  });

  it('a new verification starts it again too', async () => {
    const { fresh, again } = await detached();
    await again.engine.start();
    await again.verified.add('w', 'Agents');
    await again.engine.syncNow();
    expect(again.engine.enabled()).toBe(true);
    expect([...fresh.verified.keys()].sort()).toEqual(['v', 'w']);
  });
});

// ---- claiming this phone's old leaderboard number --------------------------------------------------

describe('account sync: the old device number', () => {
  async function enabledPhone(server: FakeServer, options: Parameters<typeof phone>[1] = {}) {
    const p = phone(server, options);
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    return p;
  }

  it('Scenario: When syncing starts the phone claims its old number once, before anything is uploaded', async () => {
    const server = new FakeServer();
    await enabledPhone(server);
    expect(server.claims).toEqual([{ deviceId: 'device-1', uploadedBefore: false }]);
  });

  it('it is not claimed again on later syncs or after a restart', async () => {
    const server = new FakeServer();
    const p = await enabledPhone(server);
    await p.local.add(USER, 'a');
    await p.engine.syncNow();
    p.engine.stop();
    const again = phone(server, { storage: p.storage });
    await again.engine.start();
    await again.engine.syncNow();
    expect(server.claims).toHaveLength(1);
  });

  it('Scenario: The badges the old number had come back to the phone after the claim', async () => {
    const server = new FakeServer();
    server.deviceRows.set('device-1', [{ article_id: 'old-1', verified_at: ago(500), topic: 'Other' }]);
    const p = await enabledPhone(server);
    expect([...server.verified.keys()]).toEqual(['old-1']);
    expect((await p.verified.list()).map((v) => v.article_id)).toEqual(['old-1']);
  });

  it('not syncing means not claiming: nothing is said to the server about this phone', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    await p.engine.syncNow();
    expect(server.claims).toEqual([]);
  });

  it('Scenario: A claim that cannot be made now does not hold up syncing, and is tried again until it works', async () => {
    const server = new FakeServer();
    server.claimScript.push('drop');
    const p = await enabledPhone(server);
    expect(server.profile?.display_name).toBe('Maya'); // the upload went ahead
    await p.engine.syncNow();
    expect(server.claims).toHaveLength(2);
    await p.engine.syncNow();
    expect(server.claims).toHaveLength(2); // done
  });

  it('a number another account already has (409) is given up on for good', async () => {
    const server = new FakeServer();
    server.claimScript.push({ kind: 'invalid' });
    const p = await enabledPhone(server);
    await p.engine.syncNow();
    await p.engine.syncNow();
    expect(server.claims).toHaveLength(1);
  });

  it('a refused session stops the sync and tells the app', async () => {
    const server = new FakeServer();
    server.claimScript.push({ kind: 'unauthorized' });
    const p = await enabledPhone(server);
    expect(p.refused).toEqual([401]);
    expect(server.profile).toBeNull();
  });

  it('a phone that restores an account that already syncs also claims its number, once', async () => {
    const server = new FakeServer();
    const first = await enabledPhone(server, { deviceId: 'device-1' });
    first.engine.stop();
    const second = phone(server, { deviceId: 'device-2' });
    await second.engine.start();
    await second.engine.syncNow();
    expect(server.claims.map((c) => c.deviceId)).toEqual(['device-1', 'device-2']);
  });

  it('after a deletion the next account claims again', async () => {
    const server = new FakeServer();
    const p = await enabledPhone(server);
    await p.engine.detach();
    const fresh = new FakeServer();
    const again = phone(fresh, { storage: p.storage });
    await again.engine.start();
    await again.local.saveProfile(profileOf('Maya C'));
    await again.engine.syncNow();
    expect(fresh.claims).toHaveLength(1);
  });
});

// ---- readers who were already using the app --------------------------------------------------------

describe('account sync: readers who were already using the app', () => {
  async function existing(server: FakeServer, setup: (p: ReturnType<typeof phone>) => Promise<void>, marked = true) {
    const p = phone(server);
    await setup(p); // what was on the phone before accounts, now under the account
    if (marked) await p.storage.setItem(MIGRATE_KEY, '1');
    await p.engine.start();
    await p.engine.syncNow();
    return p;
  }

  it('Scenario: One upload of what they already had, with no action from them', async () => {
    const server = new FakeServer();
    const p = await existing(server, async (x) => {
      await x.local.saveProfile(profileOf('Maya'));
      await x.local.add(USER, 'a');
      await x.verified.add('v', 'Cloud');
    });
    expect(p.engine.enabled()).toBe(true);
    expect(server.profile?.display_name).toBe('Maya');
    expect([...server.list.keys()]).toEqual(['a']);
    expect([...server.verified.keys()]).toEqual(['v']);
    expect(server.claims).toHaveLength(1);
  });

  it('the marker is used up: it starts syncing once and is gone', async () => {
    const server = new FakeServer();
    const p = await existing(server, async (x) => void (await x.local.saveProfile(profileOf('Maya'))));
    expect(await p.storage.getItem(MIGRATE_KEY)).toBeNull();
  });

  it('Scenario: No marker, no upload - data saved before this launch but not carried over from before accounts is not an action', async () => {
    const server = new FakeServer();
    const p = await existing(server, async (x) => void (await x.local.saveProfile(profileOf('Maya'))), false);
    expect(p.engine.enabled()).toBe(false);
    expect(server.uploaded()).toBe(false);
  });

  it('Scenario: A reader whose account was deleted and who kept their data is not uploaded, marker or not', async () => {
    const server = new FakeServer();
    const first = phone(server);
    await first.engine.start();
    await first.local.saveProfile(profileOf('Maya'));
    await first.engine.syncNow();
    await first.engine.detach();
    await first.storage.setItem(MIGRATE_KEY, '1');
    const fresh = new FakeServer();
    const again = phone(fresh, { storage: first.storage });
    await again.engine.start();
    await again.engine.syncNow();
    expect(again.engine.enabled()).toBe(false);
    expect(fresh.uploaded()).toBe(false);
  });

  it('their older leaderboard entry joins the account in the same go', async () => {
    const server = new FakeServer();
    server.deviceRows.set('device-1', [{ article_id: 'old-1', verified_at: ago(900), topic: 'Other' }]);
    const p = await existing(server, async (x) => {
      await x.local.saveProfile(profileOf('Maya'));
      await x.verified.add('old-1', 'Cloud');
    });
    expect(server.claims[0].uploadedBefore).toBe(false);
    expect([...server.verified.keys()]).toEqual(['old-1']);
    expect((await p.verified.list()).map((v) => v.article_id)).toEqual(['old-1']);
  });
});

// ---- telling the reader that syncing has started ---------------------------------------------------

describe('account sync: the one-time notice', () => {
  it('Scenario: Starting by the reader\'s own action leaves a notice to show, until it is acknowledged, and that survives a restart', async () => {
    const server = new FakeServer();
    const p = phone(server);
    await p.engine.start();
    expect(p.engine.noticePending()).toBe(false);
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    expect(p.engine.noticePending()).toBe(true);
    const restarted = phone(server, { storage: p.storage });
    await restarted.engine.start();
    expect(restarted.engine.noticePending()).toBe(true);
    await restarted.engine.acknowledgeNotice();
    expect(restarted.engine.noticePending()).toBe(false);
    const third = phone(server, { storage: p.storage });
    await third.engine.start();
    expect(third.engine.noticePending()).toBe(false);
  });

  it('starting by a first verification, or by the one-time upload, also leaves it', async () => {
    const a = phone(new FakeServer());
    await a.engine.start();
    await a.verified.add('v', 'Cloud');
    await a.engine.syncNow();
    expect(a.engine.noticePending()).toBe(true);

    const b = phone(new FakeServer());
    await b.local.saveProfile(profileOf('Maya'));
    await b.storage.setItem(MIGRATE_KEY, '1');
    await b.engine.start();
    expect(b.engine.noticePending()).toBe(true);
  });

  it('restoring an account that was already syncing on another phone does not', async () => {
    const server = new FakeServer();
    const first = phone(server);
    await first.engine.start();
    await first.local.saveProfile(profileOf('Maya'));
    await first.engine.syncNow();
    const second = phone(server);
    await second.engine.start();
    expect(second.engine.enabled()).toBe(true);
    expect(second.engine.noticePending()).toBe(false);
  });

  it('a deletion clears it', async () => {
    const p = phone(new FakeServer());
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    await p.engine.detach();
    expect(p.engine.noticePending()).toBe(false);
  });
});

describe('account sync: hearing about the notice', () => {
  it('listeners are called when the notice appears and when it is acknowledged, until they unsubscribe', async () => {
    const p = phone(new FakeServer());
    const heard = jest.fn();
    const off = p.engine.subscribeNotice(heard);
    await p.engine.start();
    await p.local.saveProfile(profileOf('Maya'));
    await p.engine.syncNow();
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    await p.engine.acknowledgeNotice();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    await p.engine.detach();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a notice left from an earlier run is announced once the engine has read its state', async () => {
    const server = new FakeServer();
    const first = phone(server);
    await first.engine.start();
    await first.local.saveProfile(profileOf('Maya'));
    await first.engine.syncNow();
    first.engine.stop();
    const again = phone(server, { storage: first.storage });
    const heard = jest.fn();
    again.engine.subscribeNotice(heard);
    await again.engine.start();
    expect(heard).toHaveBeenCalled();
    expect(again.engine.noticePending()).toBe(true);
  });
});

