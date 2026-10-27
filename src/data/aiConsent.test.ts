import { AI_CONSENT_KEY, AI_CONSENT_VERSION, createAiConsentStore } from './aiConsent';
import { createScopedStorage } from './scopedStorage';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) };
};

describe('the reader\'s agreement to send a posting to outside services', () => {
  it('has not been given until the reader gives it, and is remembered once given', async () => {
    const store = createAiConsentStore(memory());
    expect(await store.hasAgreed()).toBe(false);
    await store.agree();
    expect(await store.hasAgreed()).toBe(true);
  });

  it('is for the wording the reader saw: an agreement to an older wording is not an agreement', async () => {
    const storage = memory();
    await storage.setItem(AI_CONSENT_KEY, 'an-older-wording');
    expect(await createAiConsentStore(storage).hasAgreed()).toBe(false);
    await createAiConsentStore(storage).agree();
    expect(storage.m.get(AI_CONSENT_KEY)).toBe(AI_CONSENT_VERSION);
    expect(await createAiConsentStore(storage).hasAgreed()).toBe(true);
  });

  it('belongs to one account on the phone: another account is asked again, and the first is not', async () => {
    const base = memory();
    const storage = createScopedStorage(base);
    storage.setScope('EXC-AAAA-1111');
    await createAiConsentStore(storage).agree();
    expect(await createAiConsentStore(storage).hasAgreed()).toBe(true);
    storage.setScope('EXC-BBBB-2222');
    expect(await createAiConsentStore(storage).hasAgreed()).toBe(false);
    storage.setScope('EXC-AAAA-1111');
    expect(await createAiConsentStore(storage).hasAgreed()).toBe(true);
    expect([...base.m.keys()].every((k) => k.startsWith('swipy:acct:'))).toBe(true);
  });

  it('can be taken back, and a storage that fails never crashes anything: it just counts as not agreed', async () => {
    const storage = memory();
    const store = createAiConsentStore(storage);
    await store.agree();
    await store.withdraw();
    expect(await store.hasAgreed()).toBe(false);
    const broken = createAiConsentStore({ getItem: async () => { throw new Error('no'); }, setItem: async () => { throw new Error('no'); }, removeItem: async () => { throw new Error('no'); } });
    expect(await broken.hasAgreed()).toBe(false);
    await expect(broken.agree()).resolves.toBeUndefined();
    await expect(broken.withdraw()).resolves.toBeUndefined();
  });
});
