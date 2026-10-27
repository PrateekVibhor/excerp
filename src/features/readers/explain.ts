import type { SocialResult } from '../../data/socialApi';

export const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

const BY_CODE: Record<string, string> = {
  visibility_required: 'Turn on “Show me as reading” first.',
  'visibility required': 'Turn on “Show me as reading” first.',
  'confirmation required': 'Please confirm you are 18 or older and accept the Terms of Use.',
  'profile required': 'Save your profile first, so other readers have a name to see.',
  suspended: 'Your account is limited right now, so this is not available.',
  verify_first: 'Pass a quiz to verify an article first, then you can send messages.',
  already_requested: "You've already written to this reader.",
  awaiting_acceptance: 'Your request is waiting for a reply.',
  accept_first: 'Accept the request first.',
  closed: 'This conversation is closed.',
  expired: 'This request has expired.',
  'deleted account': "This account was deleted, so it can't be replied to.",
  'no links': "Links and email addresses aren't allowed in messages.",
  'repeated message': "You've sent this same message to several people. Write something different.",
  'not found': "This reader isn't available.",
};

/** A plain sentence for a request that did not go through. Never shows the server's own wording or codes. */
export function explain(result: SocialResult<unknown>, fallback = OFFLINE): string {
  if (result.kind === 'unauthorized') return 'Please sign in again.';
  if (result.kind === 'failed') return fallback;
  if (result.kind === 'refused') {
    if (BY_CODE[result.code]) return BY_CODE[result.code];
    if (result.status === 429) return "You've reached today's limit. Try again tomorrow.";
    if (result.status === 400) return 'That could not be sent. Check what you wrote and try again.';
    return fallback;
  }
  return '';
}
