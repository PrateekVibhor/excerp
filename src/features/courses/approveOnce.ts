import type { CourseApi, CourseResult } from '../../data/courseApi';

type Approved = CourseResult<{ courseId: string; status: string }>;
// Kept per server connection, not in a component: a screen that re-runs its effect, or opens a second time for the same list a moment later, finds the approval already made or on its way.
const approvals = new WeakMap<CourseApi, Map<string, Promise<Approved>>>();

/**
 * Approves a list once. While an approval is in flight, or after it has succeeded, asking again shares it and sends nothing. A failure or a refusal clears it, so the next ask
 * (the next poll, or the reader's Try again) sends a new one.
 */
export function approveOnce(api: CourseApi, courseId: string): Promise<Approved> {
  let mine = approvals.get(api);
  if (!mine) approvals.set(api, (mine = new Map()));
  const known = mine.get(courseId);
  if (known) return known;
  const sent = api.approve(courseId).then(
    (result) => {
      if (result.kind !== 'ok') mine!.delete(courseId);
      return result;
    },
    (error) => {
      mine!.delete(courseId);
      throw error;
    },
  );
  mine.set(courseId, sent);
  return sent;
}
