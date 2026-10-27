import { BODY_MAX, SUBJECT_MAX } from './types';

export interface DraftErrors {
  subject?: string;
  body?: string;
}

// Array.from counts what a person sees as characters, so an emoji is one.
const length = (text: string) => Array.from(text).length;

/** The subject for a reply: "Re: <subject>", not doubled, and cut to the subject limit. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed === '') return ''; // "Re: " in front of nothing says nothing
  const full = /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
  return length(full) <= SUBJECT_MAX ? full : Array.from(full).slice(0, SUBJECT_MAX).join('').trimEnd();
}

/** Subject at most 120 characters; body 1 to 2000 characters, both after trimming. The server checks the same, and for links. */
export function validateDraft(draft: { subject: string; body: string }): DraftErrors {
  const errors: DraftErrors = {};
  if (length(draft.subject.trim()) > SUBJECT_MAX) errors.subject = `Use ${SUBJECT_MAX} characters or fewer.`;
  const body = length(draft.body.trim());
  if (body === 0) errors.body = 'Write a message.';
  else if (body > BODY_MAX) errors.body = `Use ${BODY_MAX} characters or fewer.`;
  return errors;
}

/** True if the text looks like a link or an address. A first look so the reader learns before sending; the server decides. */
export function looksLikeLink(text: string): boolean {
  return /\b[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\bwww\./i.test(text) || /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|ai|app|dev|co|me|ly|xyz|info|biz)\b/i.test(text);
}
