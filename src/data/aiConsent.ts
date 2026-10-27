import type { KeyValueStorage } from './localStore';

/**
 * The wording the reader agreed to. Bump it whenever the notice, or the policy's account of the outside services, changes, and every reader is asked again before
 * their next list.
 */
export const AI_CONSENT_VERSION = 'skills-list-ai-2026-10-22';
/** Under the `swipy:` prefix, so the scoped storage keeps it for the signed-in account only. */
export const AI_CONSENT_KEY = 'swipy:ai_consent';

/**
 * The reader's agreement to sending a pasted job posting to outside services (an AI model, web and video search), kept on this phone only, for this account. A storage
 * that fails counts as "not agreed": the reader is asked again, and nothing is ever sent on the strength of a guess.
 */
export function createAiConsentStore(storage: KeyValueStorage) {
  return {
    async hasAgreed(): Promise<boolean> {
      try {
        return (await storage.getItem(AI_CONSENT_KEY)) === AI_CONSENT_VERSION;
      } catch {
        return false;
      }
    },
    async agree(): Promise<void> {
      try {
        await storage.setItem(AI_CONSENT_KEY, AI_CONSENT_VERSION);
      } catch {
        // not being able to remember only means being asked again next time
      }
    },
    async withdraw(): Promise<void> {
      try {
        await storage.removeItem?.(AI_CONSENT_KEY);
      } catch {
        // as above
      }
    },
  };
}
export type AiConsentStore = ReturnType<typeof createAiConsentStore>;
