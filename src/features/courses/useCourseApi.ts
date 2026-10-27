import { courseApi as defaultCourses } from '../../data';
import type { CourseApi } from '../../data/courseApi';
import { useAuth } from '../auth/useAuth';

/**
 * The server's list-course routes, for a reader who is signed in on an account. Null with no sign-in (mock data) or on a server without
 * accounts, which is how the screens know to say lists need the live app. A test can hand one in to use instead.
 */
export function useCourseApi(override?: CourseApi | null): CourseApi | null {
  const auth = useAuth();
  if (override !== undefined) return override;
  return auth && auth.state.kind === 'approved' && auth.accountRef !== null ? defaultCourses : null;
}
