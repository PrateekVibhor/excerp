import { Article, LeaderboardResponse, Profile, ReadingListItem, SwipeEvent, SyncVerification } from './types';

// All methods are async so a real backend (Feature 3) can replace the mock
// without changing any signature.

export interface ArticleRepository {
  /** Articles the user has not swiped yet. */
  getFeed(userId: string): Promise<Article[]>;
  getById(id: string): Promise<Article | undefined>;
}

export interface ReadingListRepository {
  /** The user's saved items, newest first. */
  list(userId: string): Promise<ReadingListItem[]>;
  add(userId: string, articleId: string): Promise<ReadingListItem>;
  remove(userId: string, articleId: string): Promise<void>;
  recordSwipe(event: SwipeEvent): Promise<void>;
}

export interface ProfileRepository {
  /** The reader's own profile, or null before one is saved. One per device. */
  getProfile(): Promise<Profile | null>;
  /** Replaces the whole profile record. */
  saveProfile(profile: Profile): Promise<Profile>;
}

/**
 * What happened to a verification sent to the server.
 * `sent`: the server has it (or already had it). `rejected`: the server will never accept it, so sending it again
 * is pointless. `retry`: the server could not take it now (offline, busy, restarting); try again later.
 */
export type PostResult = 'sent' | 'rejected' | 'retry';

export interface LeaderboardApi {
  /** Sends one verification. Never throws: every failure is a PostResult. */
  postVerification(verification: SyncVerification): Promise<PostResult>;
  /** The board, with the reader's own rank when a device id is given. Throws when it cannot be loaded. */
  getLeaderboard(deviceId?: string): Promise<LeaderboardResponse>;
}
