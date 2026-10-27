// Shared setup for the course tests that go through the real API: the harness, courses switched on, and the people who sign in.
// Lives outside src/ so it is not part of the Docker image.
import { useHarness, USERS, type UserKey } from './harness.ts';
import { createCourseSettings } from '../src/courses/settings.ts';

export function useCourseHttp(prefix: string) {
  const h = useHarness(prefix);
  /** A course test: a clean database, no roles left over, and courses switched on. */
  const ct = (name: string, fn: () => Promise<void>) =>
    h.t(name, async () => {
      await h.pool.query('TRUNCATE roles CASCADE');
      await createCourseSettings(h.pool).set('courses_off', false);
      await fn();
    });
  const idOf = async (user: UserKey): Promise<string> => (await h.rows('SELECT id FROM accounts WHERE email = $1', [USERS[user].email]))[0].id;
  /** Signs in alice, bob and carol so their accounts exist; returns each one's token and account id. */
  async function people() {
    const out = {} as Record<'alice' | 'bob' | 'carol', { token: string; id: string }>;
    for (const user of ['alice', 'bob', 'carol'] as const) out[user] = { token: (await h.signIn(user)).token, id: await idOf(user) };
    return out;
  }
  const get = (token: string | undefined, url: string) => h.call(token, 'GET', url);
  const post = (token: string | undefined, url: string, payload?: unknown) => h.call(token, 'POST', url, payload ?? {});
  const DAY = 86_400_000;
  return { h, ct, idOf, people, get, post, DAY, settings: () => createCourseSettings(h.pool) };
}
