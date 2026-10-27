import {
  DEVICE_ID_KEY,
  PROFILE_KEY,
  SAVED_KEY,
  SWIPES_KEY,
  VERIFIED_KEY,
  VERIFY_OUTBOX_KEY,
  type KeyValueStorage,
} from './localStore';

export { ACCOUNT_REF } from './accountRef';
import { ACCOUNT_REF } from './accountRef';

/** Written once, when the data from before accounts was given to the first account that signed in. */
export const LEGACY_CLAIM_KEY = 'swipy:legacy_claimed_by';
/** Kept for the phone, not for an account: the random id this phone used before accounts. */
const SHARED_KEYS = new Set([DEVICE_ID_KEY, LEGACY_CLAIM_KEY]);
/** What the app kept on the phone before accounts existed, under unscoped keys. */
export const LEGACY_KEYS = [SWIPES_KEY, SAVED_KEY, PROFILE_KEY, VERIFIED_KEY, VERIFY_OUTBOX_KEY];
/**
 * The sample inbox and the messages written in the app's earlier, local-only version. They were never real or sent anywhere, so they are
 * thrown away rather than carried over: messages are now between real readers, through the server.
 */
export const DISCARDED_KEYS = ['swipy:inbox', 'swipy:outbox'];

/** Removes the old local-only mail, wherever it is: the unscoped keys of before accounts, and under this account if it was carried over. */
export async function discardLocalMail(base: KeyValueStorage, ref: string | null): Promise<void> {
  for (const key of DISCARDED_KEYS) {
    await base.removeItem?.(key);
    if (ref !== null) await base.removeItem?.(scopedKey(ref, key));
  }
}

/**
 * Left under an account, once, when it took over data from before accounts that includes a profile or a verified article:
 * the sign that this reader was already using the app and is owed one upload, with no action from them. Used up by the sync.
 */
export const MIGRATE_KEY = 'swipy:migrate_upload';

const PREFIX = 'swipy:';
export const scopedKey = (ref: string, key: string) => `${PREFIX}acct:${ref}:${key.slice(PREFIX.length)}`;

type Base = KeyValueStorage;

function hasEntries(json: string): boolean {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

export interface ScopedStorage extends KeyValueStorage {
  removeItem(key: string): Promise<unknown>;
  /** The account whose data the keys now point at, or null for the unscoped keys of before accounts (and of mock data). */
  setScope(ref: string | null): void;
  scope(): string | null;
}

/**
 * Storage whose `swipy:` keys belong to one account at a time. With a scope set, `swipy:profile` is really
 * `swipy:acct:<ref>:profile`, so each Google account on a phone keeps its own profile, reading list, badges and so on,
 * and switching accounts loses nothing. Repositories keep using their own keys and never know.
 */
export function createScopedStorage(base: Base): ScopedStorage {
  let current: string | null = null;
  const map = (key: string) => (current !== null && key.startsWith(PREFIX) && !SHARED_KEYS.has(key) ? scopedKey(current, key) : key);
  return {
    getItem: (key) => base.getItem(map(key)),
    setItem: (key, value) => base.setItem(map(key), value),
    removeItem: async (key) => void (await base.removeItem?.(map(key))),
    setScope(ref) {
      if (ref !== null && !ACCOUNT_REF.test(ref)) throw new RangeError('not an account reference');
      current = ref;
    },
    scope: () => current,
  };
}

/**
 * The first account to sign in after the update takes over what was on the phone before accounts: its keys are copied
 * under that account and removed from where they were. Once it has happened (or on a fresh install) it never happens
 * again, so a second Google account on the same phone never inherits the first one's data. Safe to repeat after a crash:
 * nothing is removed before it has been copied. Resolves what happened.
 */
export async function claimLegacyData(base: Base, ref: string): Promise<'claimed' | 'already'> {
  if ((await base.getItem(LEGACY_CLAIM_KEY)) !== null) return 'already';
  let owedUpload = false;
  for (const key of LEGACY_KEYS) {
    const value = await base.getItem(key);
    if (value === null) continue;
    if (key === PROFILE_KEY) owedUpload = true;
    if (key === VERIFIED_KEY && hasEntries(value)) owedUpload = true;
    const target = scopedKey(ref, key);
    if ((await base.getItem(target)) === null) await base.setItem(target, value);
    await base.removeItem?.(key);
  }
  // Before the claim is recorded, so a crash between the two is repeated and not lost.
  if (owedUpload) await base.setItem(scopedKey(ref, MIGRATE_KEY), '1');
  await base.setItem(LEGACY_CLAIM_KEY, ref);
  return 'claimed';
}
