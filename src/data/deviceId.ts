import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEVICE_ID_KEY, type KeyValueStorage } from './localStore';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 16 random bytes: from the platform's secure source when it has one, from Math.random when it does not. */
export type RandomBytes = (length: number) => Uint8Array;

export const randomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  const secure = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (secure?.getRandomValues) return secure.getRandomValues(bytes);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

/** A random version 4 UUID in lower case, the form the server stores. */
export function newDeviceId(random: RandomBytes = randomBytes): string {
  const bytes = random(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // the standard variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface DeviceIdRepository {
  /**
   * The id of this device. The first call on a device makes one and keeps it, so every later call, in this run or the
   * next, gives the same id. Never rejects: when the stored value cannot be used, a working id is still returned.
   */
  get(): Promise<string>;
  /** Removes the stored id and the one held in memory, so the next get makes a new one. Never rejects. */
  forget(): Promise<void>;
}

/**
 * The device's leaderboard identity, kept under `swipy:device_id`. It is random, not a secret and not an account: a
 * reinstall makes a new one. The id is decided once per run and cached, so two screens asking at the same moment on a
 * new device cannot end up with two different ids.
 */
export function createDeviceIdRepository(storage: KeyValueStorage = AsyncStorage, random: RandomBytes = randomBytes): DeviceIdRepository {
  let pending: Promise<string> | undefined;

  async function decide(): Promise<string> {
    let stored: string | null;
    try {
      stored = await storage.getItem(DEVICE_ID_KEY);
    } catch {
      // The store could not be read, so an id may well be there. Writing a new one over it could lose it for good, so
      // this run uses a fresh id in memory only, and the next run looks again.
      return newDeviceId(random);
    }
    if (stored !== null && UUID.test(stored)) return stored.toLowerCase();
    // Nothing stored, or something that is not an id: make one and keep it.
    const id = newDeviceId(random);
    try {
      await storage.setItem(DEVICE_ID_KEY, id);
    } catch {
      // Not saved: this run still has its id; the next run will make another.
    }
    return id;
  }

  return {
    get: () => (pending ??= decide()),
    async forget() {
      pending = undefined;
      try {
        await storage.removeItem?.(DEVICE_ID_KEY);
      } catch {
        // an id left behind is only ever the old one; the next get uses it or replaces it
      }
    },
  };
}
