import type { AccountApi, AccountResult, SyncAnswer, SyncChanges, SyncListItem, SyncProfile } from './accountApi';
import type { KeyValueStorage, LocalStore } from './localStore';
import { MIGRATE_KEY } from './scopedStorage';
import type { Profile } from './types';
import type { VerifiedRepository } from './verifiedRepository';

/** Where the engine keeps its place, under the account (the storage it is given is already scoped to one). */
export const SYNC_STATE_KEY = 'swipy:sync';

const MAX_PER_REQUEST = 200;
const SKIP_BATCH = 100;
const DEBOUNCE_MS = 2_000;
const RETRY_MS = 30_000;
const PERIOD_MS = 120_000;

export interface SyncTimers {
  after(fn: () => void, ms: number): () => void;
  every(fn: () => void, ms: number): () => void;
}
const realTimers: SyncTimers = {
  after: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  every: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

interface Known {
  removed: boolean;
  saved_at: string;
  updated_at: string;
}
interface SyncState {
  /** Syncing has started for this account (the first profile or verification, or the account already had data). */
  enabled: boolean;
  /** The account was deleted and the phone kept its data: nothing is uploaded until the reader does something new. */
  detached: boolean;
  /** Where this phone is up to on the server. */
  cursor: number;
  /** What the server has for the reading list, as this phone last heard it. */
  list: Record<string, Known>;
  /** Articles the server has as verified. */
  verified: string[];
  /** The profile the server has, as text, to tell whether the phone's differs. */
  profile: string | null;
  /** When the profile was last saved on this phone. */
  profileUpdatedAt: string | null;
  /** How many skips (swipes left) have been reported. */
  skipsReported: number;
  /** This phone's old leaderboard number has been claimed for the account (or never can be). */
  deviceClaimed: boolean;
  /** Syncing started on the reader's own doing and they have not yet been told. */
  noticePending: boolean;
}
const emptyState = (): SyncState => ({ enabled: false, detached: false, cursor: 0, list: {}, verified: [], profile: null, profileUpdatedAt: null, skipsReported: 0, deviceClaimed: false, noticePending: false });

function readState(raw: string | null): SyncState {
  if (raw === null) return emptyState();
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return emptyState();
    const o = v as Partial<SyncState>;
    const base = emptyState();
    return {
      enabled: o.enabled === true,
      detached: o.detached === true,
      cursor: typeof o.cursor === 'number' && Number.isSafeInteger(o.cursor) && o.cursor >= 0 ? o.cursor : 0,
      list: typeof o.list === 'object' && o.list !== null && !Array.isArray(o.list) ? o.list : base.list,
      verified: Array.isArray(o.verified) ? o.verified.filter((x): x is string => typeof x === 'string') : base.verified,
      profile: typeof o.profile === 'string' ? o.profile : null,
      profileUpdatedAt: typeof o.profileUpdatedAt === 'string' ? o.profileUpdatedAt : null,
      skipsReported: typeof o.skipsReported === 'number' && o.skipsReported >= 0 ? o.skipsReported : 0,
      deviceClaimed: o.deviceClaimed === true,
      noticePending: o.noticePending === true,
    };
  } catch {
    return emptyState(); // junk means starting over: the server's copy is the authority
  }
}

const profileKey = (p: Profile) => JSON.stringify({ display_name: p.display_name, industry: p.industry, interests: p.interests });
const hasData = (a: SyncAnswer) => a.changes.profile !== null || a.changes.reading_list.length > 0 || a.changes.verified.length > 0;

export interface AccountSync {
  /** Begins for the account whose storage is active: reads where it was, listens for what the reader does, asks the server. */
  start(): Promise<void>;
  /** Stops listening and cancels waiting timers. Safe to call twice. */
  stop(): void;
  /** Sends what is new and takes what the server has. One at a time: asking while one runs gets that one. Never rejects. */
  syncNow(): Promise<void>;
  /** Reports skips not yet reported, from sign-in on, whether or not syncing has started. Never rejects. */
  flushSkips(): Promise<void>;
  /** After the account was deleted: forget the server's side and upload nothing until the reader's next profile save or verification. */
  detach(): Promise<void>;
  enabled(): boolean;
  /** Syncing started because of something the reader did (or the one-time upload for existing readers), and they have not been told. */
  noticePending(): boolean;
  /** The reader has been told. Remembered. */
  acknowledgeNotice(): Promise<void>;
  /** Called whenever the notice appears or goes away, and once after start() if one is waiting. Returns an unsubscribe function. */
  subscribeNotice(listener: () => void): () => void;
}

export function createAccountSync(deps: {
  storage: KeyValueStorage;
  local: LocalStore;
  verified: VerifiedRepository;
  api: AccountApi;
  getToken: () => Promise<string | null>;
  userId: string;
  /** This phone's old random leaderboard number. Left out, nothing is claimed. */
  getDeviceId?: () => Promise<string>;
  now?: () => Date;
  /** The server refused this phone's session (401) or the account (403). */
  onRefused?: (status: 401 | 403) => void;
  timers?: SyncTimers;
}): AccountSync {
  const { storage, local, verified, api, userId } = deps;
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? realTimers;

  let state = emptyState();
  let started = false;
  let applying = false;
  let dirty = false;
  let running: Promise<void> | undefined;
  let skipping: Promise<void> | undefined;
  let cancelDebounce: (() => void) | undefined;
  let cancelRetry: (() => void) | undefined;
  let cancelEvery: (() => void) | undefined;
  let unsubscribe: Array<() => void> = [];
  const noticeListeners = new Set<() => void>();
  const notifyNotice = () => noticeListeners.forEach((listener) => listener());

  const save = async () => {
    try {
      await storage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
    } catch {
      // the place is lost only if the app is closed before the next save; the next sync then repeats a little, harmlessly
    }
  };

  /** Asks for a sync as soon as the current one (if any) is done. */
  function request() {
    dirty = true;
    if (!running) void syncNow();
  }
  function schedule() {
    if (cancelDebounce) return;
    cancelDebounce = timers.after(() => {
      cancelDebounce = undefined;
      request();
    }, DEBOUNCE_MS);
  }
  function retryLater() {
    if (cancelRetry) return;
    cancelRetry = timers.after(() => {
      cancelRetry = undefined;
      request();
    }, RETRY_MS);
  }
  function refused(result: AccountResult<unknown>) {
    if (result.kind === 'unauthorized') deps.onRefused?.(401);
    else if (result.kind === 'forbidden') deps.onRefused?.(403);
  }

  /** The reader did something that starts syncing: the first profile or verification, or the first after a deletion. */
  function enable() {
    state.detached = false;
    if (!state.enabled) {
      state.enabled = true;
      state.noticePending = true;
      notifyNotice();
    }
    void save();
    request();
  }

  // ---- taking in what the server sent ----------------------------------------------------------------

  async function apply(answer: SyncAnswer, snapshotLive: Set<string>) {
    applying = true;
    try {
      const remote = answer.changes.profile;
      if (remote) {
        const mine = state.profileUpdatedAt;
        if (mine === null || Date.parse(remote.updated_at) > Date.parse(mine)) {
          await local.saveProfile({ display_name: remote.display_name, industry: remote.industry, interests: remote.interests });
          state.profileUpdatedAt = remote.updated_at;
        }
        state.profile = profileKey(remote);
      }

      if (answer.changes.reading_list.length > 0) {
        const current = new Map((await local.list(userId)).map((i) => [i.article_id, i]));
        for (const r of answer.changes.reading_list) {
          const wasKnownLive = state.list[r.article_id] !== undefined && !state.list[r.article_id].removed;
          state.list[r.article_id] = { removed: r.removed, saved_at: r.saved_at, updated_at: r.updated_at };
          const mine = current.get(r.article_id);
          if (r.removed) {
            if (!mine) continue;
            if (Date.parse(mine.saved_at) <= Date.parse(r.updated_at)) await local.remove(userId, r.article_id);
            else dirty = true; // saved here again after it was removed elsewhere: that is newer, so it is sent back
          } else if (!mine) {
            const removedMeanwhile = wasKnownLive && snapshotLive.has(r.article_id); // taken off the list here while this was under way
            if (!removedMeanwhile) await local.putSaved(userId, r.article_id, r.saved_at);
          }
        }
      }

      if (answer.changes.verified.length > 0) {
        await verified.mergeRemote(answer.changes.verified);
        const have = new Set(state.verified);
        for (const v of answer.changes.verified) have.add(v.article_id);
        state.verified = [...have];
      }
      state.cursor = Math.max(state.cursor, answer.cursor);
    } finally {
      applying = false;
    }
    await save();
  }

  // ---- working out what to send ----------------------------------------------------------------------

  type Unit = { profile: SyncProfile } | { list: SyncListItem } | { verified: SyncChanges['verified'] extends (infer V)[] | undefined ? V : never };

  async function changesToSend(): Promise<{ units: Unit[]; snapshotLive: Set<string> }> {
    const [profile, items, records] = await Promise.all([local.getProfile(), local.list(userId), verified.list()]);
    const live = new Map(items.map((i) => [i.article_id, i]));
    const units: Unit[] = [];
    const stamp = now().toISOString();
    if (profile && profileKey(profile) !== state.profile) units.push({ profile: { ...profile, updated_at: state.profileUpdatedAt ?? stamp } });
    for (const [id, item] of live) {
      const known = state.list[id];
      if (!known || known.removed) units.push({ list: { article_id: id, saved_at: item.saved_at, removed: false, updated_at: item.saved_at } });
    }
    for (const [id, known] of Object.entries(state.list)) {
      if (known.removed || live.has(id)) continue;
      // Stamped after the version being removed, even when this phone's clock is behind the one that saved it, or the server would keep the save.
      const after = new Date(Math.max(Date.parse(stamp), Date.parse(known.updated_at) + 1)).toISOString();
      units.push({ list: { article_id: id, saved_at: known.saved_at, removed: true, updated_at: after } });
    }
    const have = new Set(state.verified);
    for (const r of records) if (!have.has(r.article_id)) units.push({ verified: r });
    return { units, snapshotLive: new Set(live.keys()) };
  }

  function batchOf(units: Unit[]): SyncChanges {
    const out: SyncChanges = {};
    for (const u of units) {
      if ('profile' in u) out.profile = u.profile;
      else if ('list' in u) (out.reading_list ??= []).push(u.list);
      else (out.verified ??= []).push(u.verified);
    }
    return out;
  }

  /** One request. If the server calls it invalid, its parts are tried one by one, so one bad part cannot hold back the rest. */
  async function post(token: string, units: Unit[]): Promise<AccountResult<SyncAnswer[]>> {
    const first = await api.sync(token, state.cursor, batchOf(units));
    if (first.kind === 'ok') return { kind: 'ok', value: [first.value] };
    if (first.kind !== 'invalid') return first;
    const kinds = [units.filter((u) => 'profile' in u), units.filter((u) => 'list' in u), units.filter((u) => 'verified' in u)].filter((g) => g.length > 0);
    if (kinds.length <= 1) return first;
    const answers: SyncAnswer[] = [];
    for (const group of kinds) {
      const res = await api.sync(token, state.cursor, batchOf(group));
      if (res.kind === 'ok') {
        answers.push(res.value);
        state.cursor = Math.max(state.cursor, res.value.cursor);
      } else if (res.kind !== 'invalid') return res;
    }
    return answers.length > 0 ? { kind: 'ok', value: answers } : first;
  }

  /**
   * Makes this phone's old leaderboard number the account's, once, so what that number earned joins the account and what it
   * posts later is credited to it. A failure to claim does not hold anything up (it is tried again next time); false only
   * when the session was refused, which stops the sync.
   */
  async function claimDevice(token: string): Promise<boolean> {
    if (state.deviceClaimed || !deps.getDeviceId) return true;
    let id: string;
    try {
      id = await deps.getDeviceId();
    } catch {
      return true;
    }
    const res = await api.claimDevice(token, id);
    if (res.kind === 'ok' || res.kind === 'invalid') {
      state.deviceClaimed = true; // 'invalid': another account has it, and nothing will change that
      await save();
      return true;
    }
    refused(res);
    return res.kind === 'failed';
  }

  async function runOnce() {
    const token = await deps.getToken();
    if (!token) return;

    if (!state.enabled) {
      // Not syncing: upload nothing. Only ask whether this account already has data (a new phone), and if so, take it and join.
      const res = await api.sync(token, state.cursor, {});
      if (res.kind !== 'ok') return refused(res);
      if (hasData(res.value)) {
        state.enabled = true;
        state.detached = false;
        await apply(res.value, new Set());
        dirty = true; // now syncing: the next round claims this phone's number
      }
      return;
    }

    if (!(await claimDevice(token))) return;

    const { units, snapshotLive } = await changesToSend();
    const batches: Unit[][] = [];
    for (let i = 0; i < units.length; i += MAX_PER_REQUEST) batches.push(units.slice(i, i + MAX_PER_REQUEST));
    if (batches.length === 0) batches.push([]); // nothing to send, but still ask what is new
    for (const batch of batches) {
      const res = await post(token, batch);
      if (res.kind !== 'ok') {
        refused(res);
        if (res.kind === 'failed') retryLater();
        return;
      }
      for (const answer of res.value) await apply(answer, snapshotLive);
    }
  }

  function syncNow(): Promise<void> {
    if (running) return running;
    running = (async () => {
      try {
        do {
          dirty = false;
          try {
            await runOnce();
          } catch {
            retryLater(); // anything unexpected is treated like being offline
          }
        } while (dirty && started);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  // ---- skips ----------------------------------------------------------------------------------------

  function flushSkips(): Promise<void> {
    if (skipping) return skipping;
    skipping = (async () => {
      try {
        const token = await deps.getToken();
        if (!token) return;
        const ids = await local.getSkippedIds(userId);
        if (state.skipsReported > ids.length) state.skipsReported = ids.length; // the list was reset: start counting again
        while (state.skipsReported < ids.length) {
          const batch = ids.slice(state.skipsReported, state.skipsReported + SKIP_BATCH);
          const res = await api.skips(token, batch);
          if (res.kind === 'ok' || res.kind === 'invalid') {
            state.skipsReported += batch.length; // an invalid batch is dropped: the server will never take it
            await save();
          } else {
            refused(res);
            return;
          }
        }
      } catch {
        // tried again at the next tick
      } finally {
        skipping = undefined;
      }
    })();
    return skipping;
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------

  function stop() {
    started = false;
    unsubscribe.forEach((off) => off());
    unsubscribe = [];
    cancelDebounce?.();
    cancelRetry?.();
    cancelEvery?.();
    cancelDebounce = cancelRetry = cancelEvery = undefined;
  }

  return {
    async start() {
      stop();
      started = true;
      try {
        state = readState(await storage.getItem(SYNC_STATE_KEY));
      } catch {
        state = emptyState();
      }
      // A reader who was already using the app: their data was carried over from before accounts, so it is uploaded once
      // without them having to do anything. Never for an account that was deleted, whose data the phone kept.
      try {
        if ((await storage.getItem(MIGRATE_KEY)) !== null) {
          await storage.removeItem?.(MIGRATE_KEY);
          if (!state.detached && !state.enabled) {
            state.enabled = true;
            state.noticePending = true;
            await save();
          }
        }
      } catch {
        // tried again at the next launch
      }
      unsubscribe = [
        local.subscribe(() => {
          if (!applying && state.enabled) schedule();
        }),
        local.subscribeToProfile(() => {
          if (applying) return;
          state.profileUpdatedAt = now().toISOString();
          enable();
        }),
        verified.subscribe(() => {
          if (!applying) enable();
        }),
      ];
      cancelEvery = timers.every(() => {
        void flushSkips();
        if (state.enabled) request();
      }, PERIOD_MS);
      if (state.noticePending) notifyNotice();
      await syncNow();
      await flushSkips();
    },

    stop,
    syncNow,
    flushSkips,

    async detach() {
      const skipped = await local.getSkippedIds(userId).catch(() => [] as string[]);
      state = { ...emptyState(), detached: true, skipsReported: skipped.length };
      await save();
      notifyNotice();
    },

    enabled: () => state.enabled,
    noticePending: () => state.noticePending,
    async acknowledgeNotice() {
      state.noticePending = false;
      await save();
      notifyNotice();
    },
    subscribeNotice(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
  };
}
