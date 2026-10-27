import type { CourseResult } from '../../data/courseApi';

type Failure = Exclude<CourseResult<unknown>, { kind: 'ok' }>;
const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

/** What to say when asking for a list was refused or failed. */
export function startMessage(r: Failure): string {
  if (r.kind !== 'refused') return OFFLINE;
  switch (r.code) {
    case 'source_search_limit': return "You've asked for too many lists today. Try again tomorrow.";
    case 'source_search_cap': return 'We are busy right now. Try again later.';
    case 'list_mode_unavailable': return "A skills list isn't available for this role yet.";
    case 'text_too_long': return 'That job posting is too long. Paste a shorter one.';
    case 'course_withdrawn': return 'This course is no longer available.';
    case 'courses_off': return 'Courses are paused right now. Try again later.';
    case 'credit_cap': return 'Skills lists are paused for now: the testing budget has been used. Try again later.';
    default: return "Couldn't start your list. Try again.";
  }
}

/** The status check or the approval could not be done: said by what is true. No reply at all is the connection's trouble; a reply that was an error is ours. Both are retried by themselves. */
export const KEEP_TRYING = "Couldn't reach the server. We'll keep trying.";
export const SERVER_TROUBLE = "Something went wrong on our side. We're retrying.";
export function troubleMessage(r: { server?: true }): string {
  return r.server ? SERVER_TROUBLE : KEEP_TRYING;
}

/** What to say when the list was found but could not be approved for building. */
export function approveMessage(r: Failure): string {
  if (r.kind !== 'refused') return OFFLINE;
  switch (r.code) {
    case 'course_limit': return 'You can start one new course a day and three a month. Try again later.';
    case 'generation_cap': return 'We are busy building other lists. Try again later.';
    case 'not_enough_postings': return "We couldn't find enough job postings for this role yet to build a list.";
    case 'no_source': return "We couldn't read the posting you pasted. Try pasting it again.";
    case 'courses_off': return 'Courses are paused right now. Try again later.';
    case 'credit_cap': return 'Skills lists are paused for now: the testing budget has been used. Try again later.';
    default: return "Couldn't start building your list. Try again.";
  }
}

/** A course that ended without becoming a list. */
export function buildFailedMessage(status: string): string {
  if (status === 'withdrawn') return 'This course is no longer available.';
  return "We couldn't build this list. Try again later.";
}

/** Shown in place of the build for a list the reader stopped. Calm: nothing went wrong. */
export const CANCELLED_NOTE = 'You stopped this list. Delete it or start a new one.';

const GONE = "That list isn't there any more.";

/** Renaming a list that did not work. */
export function renameMessage(r: Failure): string {
  if (r.kind !== 'refused') return OFFLINE;
  if (r.code === 'invalid_title') return 'Use between 1 and 80 characters, on one line.';
  return r.status === 404 ? GONE : "Couldn't rename the list. Try again.";
}

/** Deleting a list that did not work. */
export function deleteMessage(r: Failure): string {
  if (r.kind !== 'refused') return OFFLINE;
  return r.status === 404 ? GONE : "Couldn't delete the list. Try again.";
}

/** Asking for a list to be checked that did not work (the hourly limit has its own message). */
export function refreshFailedMessage(r: Failure): string {
  if (r.kind !== 'refused') return OFFLINE;
  if (r.code === 'courses_off') return 'Courses are paused right now. Try again later.';
  return r.status === 404 ? GONE : "Couldn't check the list. Try again.";
}

/** Stopping a build that did not work: no reply is the connection's, an error reply is ours, anything else is a plain refusal. */
export function cancelMessage(r: Failure): string {
  if (r.kind === 'failed') return r.server ? "Something went wrong on our side. Try again." : OFFLINE;
  return "Couldn't stop the list. Try again.";
}
