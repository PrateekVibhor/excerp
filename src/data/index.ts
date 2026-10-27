import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAccountApi } from './accountApi';
import { createIntroStore, type IntroStore } from './introChoice';
import { createAiConsentStore, type AiConsentStore } from './aiConsent';
import { createAccountSync, SYNC_STATE_KEY, type AccountSync } from './accountSync';
import { createApiRepository, createLeaderboardApi } from './apiRepository';
import { createCourseApi, type CourseApi } from './courseApi';
import { createLastListStore, type LastListStore } from './lastList';
import { createListsStore, type ListsStore } from './listsStore';
import { createInboxStore, type InboxStore } from './inboxStore';
import { createSocialApi, type SocialApi } from './socialApi';
import { claimLegacyData, createScopedStorage, DISCARDED_KEYS, discardLocalMail, LEGACY_KEYS, MIGRATE_KEY, scopedKey } from './scopedStorage';
import { createSessionStore } from './sessionStore';
import { createLocalStore, type KeyValueStorage } from './localStore';
import { createDeviceIdRepository, type DeviceIdRepository } from './deviceId';
import { createSyncQueue, type SyncQueue } from './syncQueue';
import { createVerifiedRepository, type VerifiedRepository } from './verifiedRepository';
import { createMockRepositories } from './mockRepository';
import type { ArticleRepository, LeaderboardApi, ProfileRepository, ReadingListRepository } from './repository';

/** Every swipe and save on a phone belongs to this one local user; which account's data that is, is decided by the storage scope. */
export const LOCAL_USER_ID = 'local-user';

/** Does nothing: mock data has no server to sync with. */
const noSync: AccountSync = { start: async () => {}, stop: () => {}, syncNow: async () => {}, flushSkips: async () => {}, detach: async () => {}, enabled: () => false, noticePending: () => false, acknowledgeNotice: async () => {}, subscribeNotice: () => () => {} };

export interface DataConfig {
  source: string | undefined;
  apiUrl: string | undefined;
  storage?: KeyValueStorage;
  fetchFn?: typeof fetch;
  /** The signed-in session's token, for syncing. Left out, nothing syncs. */
  getToken?: () => Promise<string | null>;
  /** The server refused this phone's session (401) or account (403) while syncing. */
  onRefused?: (status: 401 | 403) => void;
}

/**
 * Screens import the repositories from here, never the raw mock array.
 * Articles come from the mock or the API; swipes and saved items always live
 * on the device, and swiped articles are filtered out of the feed locally.
 */
export function createRepositories(config: DataConfig): {
  articleRepository: ArticleRepository;
  readingListRepository: ReadingListRepository;
  /** The reader's own profile, kept on the device. */
  profileRepository: ProfileRepository;
  /** The articles whose quiz the reader has passed, kept on the device. */
  verifiedRepository: VerifiedRepository;
  /** This device's random leaderboard id, made on first use and kept. */
  deviceIdRepository: DeviceIdRepository;
  /** The leaderboard server, or a stand-in that is always unreachable when the app runs on mock data. */
  leaderboardApi: LeaderboardApi;
  /** Verifications waiting to be sent to the leaderboard. */
  syncQueue: SyncQueue;
  /** Points the phone's storage at one account's data (or at none, with null). The first account to do so takes over the data from before accounts. */
  accountScope: { activate(ref: string | null): Promise<void>; wipe(): Promise<void> };
  /** Keeps the signed-in account's saved articles, badges and profile in step with the server, and reports skips. */
  accountSync: AccountSync;
  /** Readers who choose to be seen, blocks, reports and message requests. Null on mock data, which has no server and so no other readers. */
  socialApi: SocialApi | null;
  /** List courses: ask for one, watch it build, read it. Null on mock data. */
  courseApi: CourseApi | null;
  /** The reader's skills lists, one shared copy for the tab, its dot and the list panel. Null on mock data. */
  listsStore: ListsStore | null;
  /** Which list the reader had open last, kept per account. */
  lastListStore: LastListStore;
  /** Whether the reader agreed to a pasted posting going to outside services, kept on this phone, per account. */
  aiConsentStore: AiConsentStore;
  /** Whether the reader chose not to see the intro cards again, kept on this phone, per account. */
  introStore: IntroStore;
  /** The reader's inbox, shared by the badge and the inbox screens. Null on mock data. */
  inboxStore: InboxStore | null;
  /** Notifies after a saved item is added or removed, so the tab badge can follow. */
  subscribeToReadingList: (listener: () => void) => () => void;
} {
  // Every repository reads and writes through this, so which account's data they see is one switch.
  const baseStorage = config.storage ?? AsyncStorage;
  const storage = createScopedStorage(baseStorage);
  const store = createLocalStore(storage);
  const source = config.source ?? 'mock';

  let articles: ArticleRepository;
  if (source === 'mock') {
    articles = createMockRepositories().articles;
  } else if (source === 'api') {
    if (!config.apiUrl) throw new Error('EXPO_PUBLIC_API_URL is required when the data source is "api"');
    articles = createApiRepository(config.apiUrl, config.fetchFn);
  } else {
    throw new Error(`EXPO_PUBLIC_DATA_SOURCE must be "mock" or "api", got "${source}"`);
  }

  // Mock data has no server behind it, so the leaderboard is simply unreachable there.
  const leaderboardApi: LeaderboardApi =
    source === 'api' ? createLeaderboardApi(config.apiUrl!, config.fetchFn) : { postVerification: async () => 'retry', getLeaderboard: async () => { throw new Error('The leaderboard needs the live data source'); } };
  const socialApi = source === 'api' && config.apiUrl && config.getToken ? createSocialApi(config.apiUrl, config.getToken, config.fetchFn) : null;
  const courseApi = source === 'api' && config.apiUrl && config.getToken ? createCourseApi(config.apiUrl, config.getToken, config.fetchFn) : null;
  const deviceIdRepository = createDeviceIdRepository(storage);
  const verifiedRepository = createVerifiedRepository(storage);

  return {
    articleRepository: {
      async getFeed(userId) {
        const [feed, swiped] = await Promise.all([articles.getFeed(userId), store.getSwipedIds(userId)]);
        return feed.filter((a) => !swiped.has(a.id));
      },
      getById: (id) => articles.getById(id),
    },
    readingListRepository: store,
    profileRepository: store,
    verifiedRepository,
    deviceIdRepository,
    leaderboardApi,
    syncQueue: createSyncQueue({
      storage,
      api: leaderboardApi,
      getDeviceId: deviceIdRepository.get,
      getDisplayName: async () => (await store.getProfile())?.display_name,
    }),
    accountScope: {
      async activate(ref) {
        if (ref === null) return storage.setScope(null);
        await claimLegacyData(baseStorage, ref); // may reject: the caller lets the reader in anyway, and the next launch tries again
        await discardLocalMail(baseStorage, ref); // the old sample inbox and drafts are not real messages
        storage.setScope(ref);
      },
      /** Removes everything this phone holds for the active account (not the phone's own id). Does nothing with no account active. */
      async wipe() {
        const ref = storage.scope();
        if (ref === null) return;
        const prefix = scopedKey(ref, 'swipy:');
        const found = (await baseStorage.getAllKeys?.()) ?? [];
        const known = [...LEGACY_KEYS, ...DISCARDED_KEYS, SYNC_STATE_KEY, MIGRATE_KEY].map((k) => scopedKey(ref, k));
        for (const key of new Set([...found.filter((k) => k.startsWith(prefix)), ...known])) await baseStorage.removeItem?.(key);
      },
    },
    socialApi,
    courseApi,
    listsStore: courseApi ? createListsStore(courseApi, config.onRefused) : null,
    lastListStore: createLastListStore(storage),
    aiConsentStore: createAiConsentStore(storage),
    introStore: createIntroStore(storage),
    inboxStore: socialApi ? createInboxStore(socialApi, config.onRefused) : null,
    accountSync:
      source === 'api' && config.apiUrl
        ? createAccountSync({
            storage,
            local: store,
            verified: verifiedRepository,
            api: createAccountApi(config.apiUrl, config.fetchFn),
            getToken: config.getToken ?? (async () => null),
            userId: LOCAL_USER_ID,
            getDeviceId: deviceIdRepository.get,
            onRefused: config.onRefused,
          })
        : noSync,
    subscribeToReadingList: store.subscribe,
  };
}

// Expo inlines these at build time, so they must be read as literal property accesses.
const sessions = createSessionStore();
let refusedHandler: ((status: 401 | 403) => void) | undefined;
/** The sign-in layer says what to do when syncing finds the session gone (401) or the account not approved (403). */
export const setRefusedHandler = (handler: ((status: 401 | 403) => void) | undefined) => {
  refusedHandler = handler;
};

export const { articleRepository, readingListRepository, profileRepository, verifiedRepository, deviceIdRepository, leaderboardApi, syncQueue, accountScope, accountSync, socialApi, courseApi, listsStore, lastListStore, aiConsentStore, introStore, inboxStore, subscribeToReadingList } =createRepositories({
  source: process.env.EXPO_PUBLIC_DATA_SOURCE,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  getToken: async () => (await sessions.load())?.token ?? null,
  onRefused: (status) => refusedHandler?.(status),
});

export type { ArticleRepository, LeaderboardApi, PostResult, ProfileRepository, ReadingListRepository } from './repository';
export { newDeviceId, type DeviceIdRepository } from './deviceId';
export { FALLBACK_NAME, leaderboardName, type FlushResult, type SyncQueue } from './syncQueue';
export { OTHER_TOPIC, topicFor, type VerifiedRepository } from './verifiedRepository';
export { looksLikeLink, replySubject, validateDraft, type DraftErrors } from './messageDraft';
export * from './types';

