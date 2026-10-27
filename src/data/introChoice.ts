import type { KeyValueStorage } from './localStore';

/** Under the `swipy:` prefix, so the scoped storage keeps it for the signed-in account only (and a deleted account's wipe takes it too). */
export const INTRO_HIDDEN_KEY = 'swipy:intro_hidden';

/** Whether the reader ticked "Don't show this again" on the intro cards, kept on this phone only. A storage that fails counts as "not ticked": the cards show. */
export function createIntroStore(storage: KeyValueStorage) {
  return {
    async isHidden(): Promise<boolean> {
      try {
        return (await storage.getItem(INTRO_HIDDEN_KEY)) === '1';
      } catch {
        return false;
      }
    },
    async hide(): Promise<void> {
      try {
        await storage.setItem(INTRO_HIDDEN_KEY, '1');
      } catch {
        // not being able to remember only means seeing the cards again
      }
    },
  };
}
export type IntroStore = ReturnType<typeof createIntroStore>;
