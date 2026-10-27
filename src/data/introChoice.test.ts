import { createIntroStore, INTRO_HIDDEN_KEY } from './introChoice';
import { createScopedStorage } from './scopedStorage';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) };
};
const broken = { getItem: async () => { throw new Error('no'); }, setItem: async () => { throw new Error('no'); }, removeItem: async () => { throw new Error('no'); } };

describe('the choice not to see the intro cards again', () => {
  it('is not made until the reader makes it, and is remembered once made', async () => {
    const store = createIntroStore(memory());
    expect(await store.isHidden()).toBe(false);
    await store.hide();
    expect(await store.isHidden()).toBe(true);
  });

  it('a storage that fails never throws: the cards simply show', async () => {
    const store = createIntroStore(broken);
    expect(await store.isHidden()).toBe(false);
    await expect(store.hide()).resolves.toBeUndefined();
  });

  it('belongs to one account on the phone, so another account sees the cards and the first does not lose its choice', async () => {
    const base = memory();
    const storage = createScopedStorage(base);
    storage.setScope('EXC-AAAA-1111');
    await createIntroStore(storage).hide();
    storage.setScope('EXC-BBBB-2222');
    expect(await createIntroStore(storage).isHidden()).toBe(false);
    storage.setScope('EXC-AAAA-1111');
    expect(await createIntroStore(storage).isHidden()).toBe(true);
    expect(base.m.has(`swipy:acct:EXC-AAAA-1111:${INTRO_HIDDEN_KEY.slice('swipy:'.length)}`)).toBe(true);
  });
});
