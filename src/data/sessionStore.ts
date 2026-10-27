import * as SecureStore from 'expo-secure-store';
import { ACCOUNT_REF } from './accountRef';

/** Secure storage keys may hold only letters, digits, ".", "-" and "_": no colon, unlike the other swipy keys. */
export const SESSION_KEY = 'swipy.session';

/** What the app keeps between launches once the server has approved the reader. */
export interface StoredSession {
  /** The session token the server issued. Sent as "Authorization: Bearer". */
  token: string;
  expires_at: string;
  /** When the server last said "approved": the 7-day offline allowance counts from here. */
  last_approved_at: string;
  /** The account this session belongs to; absent for a session made before accounts. */
  account_ref?: string;
  /** 'apple' when Sign in with Apple made it: Apple has no silent sign-in, and deleting an Apple account asks Apple again. Absent for every Google session, as before Apple existed. */
  provider?: 'google' | 'apple';
}

export interface SecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<unknown>;
  deleteItemAsync(key: string): Promise<unknown>;
}

export interface SessionStore {
  /** The saved session, or null. Never rejects: anything unreadable or of the wrong shape means signed out. */
  load(): Promise<StoredSession | null>;
  /** Rejects when secure storage cannot be written, so the caller can still let the reader in for this run. */
  save(session: StoredSession): Promise<void>;
  /** Never rejects. */
  clear(): Promise<void>;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function createSessionStore(storage: SecureStorage = SecureStore): SessionStore {
  return {
    async load() {
      try {
        const raw = await storage.getItemAsync(SESSION_KEY);
        if (raw === null) return null;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const { token, expires_at, last_approved_at } = value as Record<string, unknown>;
        if (typeof token !== 'string' || token === '' || !isDate(expires_at) || !isDate(last_approved_at)) return null;
        const account_ref = (value as Record<string, unknown>).account_ref;
        const provider = (value as Record<string, unknown>).provider;
        return { token, expires_at, last_approved_at, ...(typeof account_ref === 'string' && ACCOUNT_REF.test(account_ref) ? { account_ref } : {}), ...(provider === 'apple' || provider === 'google' ? { provider } : {}) };
      } catch {
        return null;
      }
    },

    async save(session) {
      const { token, expires_at, last_approved_at, account_ref, provider } = session;
      await storage.setItemAsync(SESSION_KEY, JSON.stringify({ token, expires_at, last_approved_at, ...(account_ref ? { account_ref } : {}), ...(provider === 'apple' ? { provider } : {}) }));
    },

    async clear() {
      try {
        await storage.deleteItemAsync(SESSION_KEY);
      } catch {
        // nothing more can be done; the next launch asks the server, which is the authority
      }
    },
  };
}
