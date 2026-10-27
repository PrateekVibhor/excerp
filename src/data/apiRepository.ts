import type { ArticleRepository, LeaderboardApi, PostResult } from './repository';
import type { Article, LeaderboardResponse, LeaderboardRow } from './types';

const TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

/**
 * ArticleRepository over the Feature 3 backend. Assumed contract, to be
 * confirmed when Feature 3 ships: GET /feed returns Article[] and
 * GET /articles/:id returns one Article or 404.
 * Failures throw; there is deliberately no fallback to mock data.
 */
export function createApiRepository(baseUrl: string, fetchFn: Fetch = fetch): ArticleRepository {
  const root = baseUrl.replace(/\/+$/, '');

  async function getJson(path: string, allow404 = false): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(`${root}${path}`, { signal: controller.signal });
      if (allow404 && res.status === 404) return undefined;
      if (!res.ok) throw new Error(`Request to ${path} failed with status ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const isArticle = (v: unknown): v is Article =>
    typeof v === 'object' && v !== null && typeof (v as Article).id === 'string';

  return {
    async getFeed(userId) {
      const body = await getJson(`/feed?user_id=${encodeURIComponent(userId)}`);
      if (!Array.isArray(body) || !body.every(isArticle)) {
        throw new Error('Unexpected response from /feed');
      }
      return body;
    },
    async getById(id) {
      const body = await getJson(`/articles/${encodeURIComponent(id)}`, true);
      if (body === undefined) return undefined;
      if (!isArticle(body)) throw new Error('Unexpected response from /articles/:id');
      return body;
    },
  };
}

/** Statuses that mean "this will never be accepted": the server understood the request and refused its content. */
const NEVER_ACCEPTED = new Set([400, 413, 415, 422]);

const isRow = (v: unknown): v is LeaderboardRow =>
  typeof v === 'object' && v !== null && typeof (v as LeaderboardRow).rank === 'number' && typeof (v as LeaderboardRow).display_name === 'string' && typeof (v as LeaderboardRow).count === 'number' && typeof (v as LeaderboardRow).is_you === 'boolean';

/**
 * The leaderboard endpoints of the Feature 9 backend. Sending never throws and never waits long: an answer of 204 is
 * `sent`, a refusal of the content is `rejected`, and anything else (no network, a timeout, 404 from a server that has
 * not been updated yet, 429, 5xx) is `retry`, so the verification waits in the queue and nothing is lost.
 */
export function createLeaderboardApi(baseUrl: string, fetchFn: Fetch = fetch): LeaderboardApi {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetchFn(`${root}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async postVerification(verification): Promise<PostResult> {
      try {
        const res = await request('/verifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(verification) });
        if (res.status === 204 || res.status === 200) return 'sent';
        return NEVER_ACCEPTED.has(res.status) ? 'rejected' : 'retry';
      } catch {
        return 'retry';
      }
    },

    async getLeaderboard(deviceId): Promise<LeaderboardResponse> {
      const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
      const res = await request(`/leaderboard${query}`, { method: 'GET' });
      if (!res.ok) throw new Error(`Request to /leaderboard failed with status ${res.status}`);
      const body = (await res.json()) as Partial<LeaderboardResponse> | null;
      if (!body || !Array.isArray(body.rows) || !body.rows.every(isRow) || !(body.you === null || isRow(body.you))) throw new Error('Unexpected response from /leaderboard');
      const only = ({ rank, display_name, count, is_you }: LeaderboardRow): LeaderboardRow => ({ rank, display_name, count, is_you }); // nothing the server adds beyond these is passed on
      return { rows: body.rows.map(only), you: body.you === null ? null : only(body.you) };
    },
  };
}
