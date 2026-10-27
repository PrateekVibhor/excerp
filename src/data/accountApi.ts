import type { Profile, VerifiedRecord } from './types';

/** A profile as it syncs: the whole record and when it was last saved. */
export interface SyncProfile extends Profile {
  updated_at: string;
}
export interface SyncListItem {
  article_id: string;
  saved_at: string;
  removed: boolean;
  updated_at: string;
}
export interface SyncChanges {
  profile?: SyncProfile;
  reading_list?: SyncListItem[];
  verified?: VerifiedRecord[];
}
export interface SyncAnswer {
  cursor: number;
  changes: { profile: SyncProfile | null; reading_list: SyncListItem[]; verified: VerifiedRecord[] };
}

/**
 * What came back. 'unauthorized' (401): the session is gone. 'forbidden' (403): not approved any more. 'invalid' (400): the
 * server will never accept this request as sent. 'failed': no answer worth trusting (offline, busy, nonsense); try again later.
 */
export type AccountResult<T> = { kind: 'ok'; value: T } | { kind: 'unauthorized' } | { kind: 'forbidden' } | { kind: 'invalid' } | { kind: 'failed' };

export interface AccountApi {
  sync(token: string, cursor: number, changes: SyncChanges): Promise<AccountResult<SyncAnswer>>;
  /** Tells the server which articles were skipped; each id is one skip. At most 100. */
  skips(token: string, articleIds: string[]): Promise<AccountResult<null>>;
  /** Makes this phone's old random id the account's, so its leaderboard entry joins the account. */
  claimDevice(token: string, deviceId: string): Promise<AccountResult<{ folded: number }>>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

function readProfile(v: unknown): SyncProfile | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !str(v.display_name) || !str(v.industry) || !Array.isArray(v.interests) || !v.interests.every(str) || !str(v.updated_at)) return undefined;
  return { display_name: v.display_name, industry: v.industry as Profile['industry'], interests: v.interests as string[], updated_at: v.updated_at };
}
const readList = (v: unknown): SyncListItem[] | undefined =>
  Array.isArray(v) && v.every((i) => isObject(i) && str(i.article_id) && str(i.saved_at) && typeof i.removed === 'boolean' && str(i.updated_at)) ? (v as SyncListItem[]) : undefined;
const readVerified = (v: unknown): VerifiedRecord[] | undefined =>
  Array.isArray(v) && v.every((i) => isObject(i) && str(i.article_id) && str(i.verified_at) && str(i.topic)) ? (v as VerifiedRecord[]) : undefined;

/** The /me endpoints of the API (Plan 14). Anything it cannot be sure of is 'failed'. Tokens are never logged. */
export function createAccountApi(baseUrl: string, fetchFn: Fetch = fetch, timeoutMs = TIMEOUT_MS): AccountApi {
  const root = baseUrl.replace(/\/+$/, '');

  async function post(path: string, token: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(`${root}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const refusal = (status: number): AccountResult<never> | null =>
    status === 401 ? { kind: 'unauthorized' } : status === 403 ? { kind: 'forbidden' } : status === 400 ? { kind: 'invalid' } : null;

  return {
    async sync(token, cursor, changes) {
      try {
        const res = await post('/me/sync', token, { cursor, changes });
        const refused = refusal(res.status);
        if (refused) return refused;
        if (res.status !== 200) return { kind: 'failed' };
        const b: unknown = await res.json();
        if (!isObject(b) || typeof b.cursor !== 'number' || !Number.isSafeInteger(b.cursor) || !isObject(b.changes)) return { kind: 'failed' };
        const profile = readProfile(b.changes.profile);
        const reading_list = readList(b.changes.reading_list);
        const verified = readVerified(b.changes.verified);
        if (profile === undefined || !reading_list || !verified) return { kind: 'failed' };
        return { kind: 'ok', value: { cursor: b.cursor, changes: { profile, reading_list, verified } } };
      } catch {
        return { kind: 'failed' };
      }
    },

    async skips(token, articleIds) {
      try {
        const res = await post('/me/skips', token, { article_ids: articleIds });
        const refused = refusal(res.status);
        if (refused) return refused;
        return res.status === 204 ? { kind: 'ok', value: null } : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },

    async claimDevice(token, deviceId) {
      try {
        const res = await post('/me/claim-device', token, { device_id: deviceId });
        if (res.status === 409) return { kind: 'invalid' }; // another account has it: nothing to do, ever
        const refused = refusal(res.status);
        if (refused) return refused;
        if (res.status !== 200) return { kind: 'failed' };
        const b: unknown = await res.json();
        return isObject(b) && typeof b.folded === 'number' ? { kind: 'ok', value: { folded: b.folded } } : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
