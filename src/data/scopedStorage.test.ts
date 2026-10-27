import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACCOUNT_REF, claimLegacyData, createScopedStorage, discardLocalMail, LEGACY_CLAIM_KEY, MIGRATE_KEY, scopedKey } from './scopedStorage';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const A = 'EXC-7K4Q-92M3';
const B = 'EXC-0000-ABCD';
beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('createScopedStorage', () => {
  it('with no scope the keys are the old, unscoped ones (mock data, and a phone before accounts)', async () => {
    const s = createScopedStorage(AsyncStorage);
    await s.setItem('swipy:profile', 'p');
    expect(await AsyncStorage.getItem('swipy:profile')).toBe('p');
    expect(s.scope()).toBeNull();
  });

  it('with a scope, each swipy key lives under the account, and another account sees none of it', async () => {
    const s = createScopedStorage(AsyncStorage);
    s.setScope(A);
    await s.setItem('swipy:profile', 'alice');
    s.setScope(B);
    expect(await s.getItem('swipy:profile')).toBeNull();
    await s.setItem('swipy:profile', 'bob');
    s.setScope(A);
    expect(await s.getItem('swipy:profile')).toBe('alice');
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:profile'))).toBe('alice');
    expect(await AsyncStorage.getItem('swipy:profile')).toBeNull(); // the unscoped key was never touched
  });

  it('removeItem follows the scope too', async () => {
    const s = createScopedStorage(AsyncStorage);
    s.setScope(A);
    await s.setItem('swipy:verified', '[]');
    s.setScope(B);
    await s.removeItem('swipy:verified');
    s.setScope(A);
    expect(await s.getItem('swipy:verified')).toBe('[]');
    await s.removeItem('swipy:verified');
    expect(await s.getItem('swipy:verified')).toBeNull();
  });

  it('the phone\'s own device id is shared by every account', async () => {
    const s = createScopedStorage(AsyncStorage);
    s.setScope(A);
    await s.setItem('swipy:device_id', 'device-1');
    s.setScope(B);
    expect(await s.getItem('swipy:device_id')).toBe('device-1');
    expect(await AsyncStorage.getItem('swipy:device_id')).toBe('device-1');
  });

  it('keys that are not swipy keys are never touched', async () => {
    const s = createScopedStorage(AsyncStorage);
    s.setScope(A);
    await s.setItem('other:thing', 'x');
    expect(await AsyncStorage.getItem('other:thing')).toBe('x');
  });

  it('refuses a scope that is not an account reference, so nothing odd ever becomes part of a key', () => {
    const s = createScopedStorage(AsyncStorage);
    for (const bad of ['', 'EXC-1', 'alice@example.com', '../x', 'EXC-7K4Q-92M3:x', 'exc-7k4q-92m3']) expect(() => s.setScope(bad)).toThrow(RangeError);
    expect(() => s.setScope(null)).not.toThrow();
    expect(ACCOUNT_REF.test(A)).toBe(true);
  });
});

describe('claimLegacyData', () => {
  const legacy = { 'swipy:profile': '{"display_name":"Maya"}', 'swipy:reading_list': '[{"id":"x"}]', 'swipy:verified': '[{"article_id":"a"}]', 'swipy:swipes': '[]', 'swipy:verify_outbox': '[]' };

  it('Scenario: the first account to sign in after the update gets what was on the phone, and the old keys are gone', async () => {
    for (const [k, v] of Object.entries(legacy)) await AsyncStorage.setItem(k, v);
    await AsyncStorage.setItem('swipy:device_id', 'dev');
    expect(await claimLegacyData(AsyncStorage, A)).toBe('claimed');
    for (const [k, v] of Object.entries(legacy)) {
      expect(await AsyncStorage.getItem(scopedKey(A, k))).toBe(v);
      expect(await AsyncStorage.getItem(k)).toBeNull();
    }
    expect(await AsyncStorage.getItem('swipy:device_id')).toBe('dev'); // the phone's id stays the phone's
    expect(await AsyncStorage.getItem(LEGACY_CLAIM_KEY)).toBe(A);
  });

  it('Scenario: a second account on the same phone inherits nothing', async () => {
    await AsyncStorage.setItem('swipy:profile', 'maya');
    await claimLegacyData(AsyncStorage, A);
    expect(await claimLegacyData(AsyncStorage, B)).toBe('already');
    expect(await AsyncStorage.getItem(scopedKey(B, 'swipy:profile'))).toBeNull();
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:profile'))).toBe('maya');
  });

  it('a fresh install claims nothing but is marked, so nobody can claim later data', async () => {
    expect(await claimLegacyData(AsyncStorage, A)).toBe('claimed');
    await AsyncStorage.setItem('swipy:profile', 'unscoped, written later');
    expect(await claimLegacyData(AsyncStorage, B)).toBe('already');
  });

  it('repeating after a crash half way finishes the job without losing or overwriting anything', async () => {
    await AsyncStorage.setItem('swipy:profile', 'old');
    await AsyncStorage.setItem('swipy:verified', 'v');
    await AsyncStorage.setItem(scopedKey(A, 'swipy:profile'), 'already copied'); // copied before the crash, original not yet removed
    await claimLegacyData(AsyncStorage, A);
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:profile'))).toBe('already copied');
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:verified'))).toBe('v');
    expect(await AsyncStorage.getItem('swipy:profile')).toBeNull();
  });

  it('nothing is removed before it has been copied: a failed write leaves the original in place and the marker unset', async () => {
    await AsyncStorage.setItem('swipy:profile', 'keep me');
    const failing = { getItem: AsyncStorage.getItem.bind(AsyncStorage), removeItem: AsyncStorage.removeItem.bind(AsyncStorage), setItem: async () => { throw new Error('disk full'); } };
    await expect(claimLegacyData(failing, A)).rejects.toThrow('disk full');
    expect(await AsyncStorage.getItem('swipy:profile')).toBe('keep me');
    expect(await AsyncStorage.getItem(LEGACY_CLAIM_KEY)).toBeNull();
  });
});

describe('claimLegacyData: marking who is owed a one-time upload', () => {
  const marked = async (ref: string) => (await AsyncStorage.getItem(scopedKey(ref, MIGRATE_KEY))) !== null;

  it('Scenario: an existing reader with a profile is marked, so the first sync can carry their data up once', async () => {
    await AsyncStorage.setItem('swipy:profile', '{"display_name":"Maya"}');
    await claimLegacyData(AsyncStorage, A);
    expect(await marked(A)).toBe(true);
  });

  it('a reader with a verified article is marked', async () => {
    await AsyncStorage.setItem('swipy:verified', '[{"article_id":"a","verified_at":"2026-10-01T00:00:00.000Z","topic":"Cloud"}]');
    await claimLegacyData(AsyncStorage, A);
    expect(await marked(A)).toBe(true);
  });

  it('a reader with only a reading list or swipes, or an empty verified list, is not marked: that alone never starts syncing', async () => {
    await AsyncStorage.setItem('swipy:reading_list', '[{"id":"x"}]');
    await AsyncStorage.setItem('swipy:swipes', '[{"article_id":"x"}]');
    await AsyncStorage.setItem('swipy:verified', '[]');
    await claimLegacyData(AsyncStorage, A);
    expect(await marked(A)).toBe(false);
  });

  it('a fresh install is not marked, and neither is a second account on the same phone', async () => {
    await claimLegacyData(AsyncStorage, A);
    expect(await marked(A)).toBe(false);
    await AsyncStorage.setItem('swipy:profile', 'later, unscoped');
    await claimLegacyData(AsyncStorage, B);
    expect(await marked(B)).toBe(false);
  });

  it('the marker is written before the claim is recorded, so a crash in between is repeated, not lost', async () => {
    await AsyncStorage.setItem('swipy:profile', 'p');
    const order: string[] = [];
    const watching = {
      getItem: AsyncStorage.getItem.bind(AsyncStorage),
      removeItem: AsyncStorage.removeItem.bind(AsyncStorage),
      setItem: async (k: string, v: string) => { order.push(k); return AsyncStorage.setItem(k, v); },
    };
    await claimLegacyData(watching, A);
    expect(order.indexOf(scopedKey(A, MIGRATE_KEY))).toBeGreaterThan(-1);
    expect(order.indexOf(scopedKey(A, MIGRATE_KEY))).toBeLessThan(order.indexOf(LEGACY_CLAIM_KEY));
  });
});

describe('discardLocalMail', () => {
  it('Scenario: the sample inbox and the drafts of the local-only version are thrown away, wherever they are, and nothing else is touched', async () => {
    await AsyncStorage.setItem('swipy:inbox', '[sample]');
    await AsyncStorage.setItem('swipy:outbox', '[drafts]');
    await AsyncStorage.setItem(scopedKey(A, 'swipy:inbox'), '[carried over by an earlier build]');
    await AsyncStorage.setItem(scopedKey(A, 'swipy:outbox'), '[drafts]');
    await AsyncStorage.setItem(scopedKey(A, 'swipy:profile'), 'keep me');
    await AsyncStorage.setItem(scopedKey(B, 'swipy:inbox'), "someone else's, left alone");
    await discardLocalMail(AsyncStorage, A);
    for (const key of ['swipy:inbox', 'swipy:outbox', scopedKey(A, 'swipy:inbox'), scopedKey(A, 'swipy:outbox')]) expect(await AsyncStorage.getItem(key)).toBeNull();
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:profile'))).toBe('keep me');
    expect(await AsyncStorage.getItem(scopedKey(B, 'swipy:inbox'))).not.toBeNull();
  });
  it('the old mail is not carried over to the first account that signs in', async () => {
    await AsyncStorage.setItem('swipy:inbox', '[sample]');
    await AsyncStorage.setItem('swipy:profile', 'p');
    await claimLegacyData(AsyncStorage, A);
    expect(await AsyncStorage.getItem(scopedKey(A, 'swipy:inbox'))).toBeNull();
    await discardLocalMail(AsyncStorage, A);
    expect(await AsyncStorage.getItem('swipy:inbox')).toBeNull();
  });
});

