import { socialApi as defaultSocial } from '../../data';
import type { SocialApi } from '../../data/socialApi';
import { useAuth } from '../auth/useAuth';

/**
 * The server's social routes, for a reader who is signed in on an account. Null with no sign-in (mock data) or on a server without
 * accounts, which is how the screens know to show nothing of other readers. A test can hand one in to use instead.
 */
export function useSocialApi(override?: SocialApi | null): SocialApi | null {
  const auth = useAuth();
  if (override !== undefined) return override;
  return auth && auth.state.kind === 'approved' && auth.accountRef !== null ? defaultSocial : null;
}
