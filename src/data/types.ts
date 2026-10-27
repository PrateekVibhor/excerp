/** What kind of piece an article is. The first four describe tech publishers, the last three business and finance ones. */
export const CONTENT_TYPES = [
  'Research Paper',
  'White Paper',
  'Tech Blog',
  'Release',
  'Consulting',
  'Finance',
  'Venture Capital',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const SOURCE_COMPANIES = [
  'NVIDIA',
  'Google',
  'Meta',
  'OpenAI',
  'Anthropic',
  'AWS',
  'Microsoft',
  // Business and Finance
  'McKinsey',
  'BCG',
  'Bain & Company',
  'CFA Institute',
  'Harvard Business Review',
  'MIT Sloan Management Review',
  'BlackRock',
  'World Economic Forum',
  'Y Combinator',
  'Sequoia Capital',
  'Andreessen Horowitz',
  'General Catalyst',
] as const;
export type SourceCompany = (typeof SOURCE_COMPANIES)[number];

/** ISO 8601 date-time string. */
export type IsoDate = string;

export type SwipeDirection = 'left' | 'right';

/** One multiple-choice question about a summary: four different options, one of them correct. */
export interface QuizQuestion {
  prompt: string;
  options: string[];
  /** 0 to 3: the position of the right answer in `options`. */
  correct_index: number;
}

/** Exactly three questions, one per key point of the summary (Feature 8). */
export interface Quiz {
  questions: QuizQuestion[];
}

export interface Article {
  id: string;
  source_company: SourceCompany;
  source_url: string;
  content_type: ContentType;
  title: string;
  summary: string;
  published_at: IsoDate;
  fetched_at: IsoDate;
  reader_count: number;
  /** Absent or null when the article has no quiz; older API responses leave both fields out. */
  quiz?: Quiz | null;
  /** One of the interest topics, or absent or null when unknown. */
  topic?: string | null;
}

/** Fixed choices for the on-device profile (Feature 6). */
export const INDUSTRIES = [
  'Software',
  'Healthcare',
  'Finance',
  'Education',
  'Manufacturing',
  'Media',
  'Other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const INTERESTS = [
  'Generative AI',
  'Agents',
  'Chips and hardware',
  'Cloud',
  'Open source',
  'Safety',
  'Research',
  'Developer tools',
] as const;
export type Interest = (typeof INTERESTS)[number];

/** The topic a verified article is filed under when it has none of the 8 interest topics. */
export const OTHER_TOPIC = 'Other';

/** Kept on the device when a reader passes an article's quiz (Feature 8). One per article. */
export interface VerifiedRecord {
  article_id: string;
  verified_at: IsoDate;
  /** The article's interest topic when it was verified, "Other" when it had none. */
  topic: string;
}

/** The reader's own profile. Kept on the device only; it never affects the Feed. */
export interface Profile {
  display_name: string;
  industry: Industry;
  /** Preset topics, plus any topic the reader typed under "Other", stored the same way. */
  interests: string[];
}

export const SUBJECT_MAX = 120;
export const BODY_MAX = 2000;

export interface User {
  id: string;
  display_name: string;
  avatar_url?: string;
  interests: string[];
}

export interface ReadingListItem {
  id: string;
  user_id: string;
  article_id: string;
  saved_at: IsoDate;
}

export interface SwipeEvent {
  user_id: string;
  article_id: string;
  direction: SwipeDirection;
  swiped_at: IsoDate;
}

/** One verification as the leaderboard server takes it (spec-9). */
export interface SyncVerification {
  device_id: string;
  display_name: string;
  article_id: string;
  verified_at: IsoDate;
}

export interface LeaderboardRow {
  rank: number;
  display_name: string;
  count: number;
  /** True for the reader's own row. */
  is_you: boolean;
}

export interface LeaderboardResponse {
  /** The top rows, best first. */
  rows: LeaderboardRow[];
  /** The reader's own row with their true rank, even beyond the rows shown; null when they are not on the board. */
  you: LeaderboardRow | null;
}
