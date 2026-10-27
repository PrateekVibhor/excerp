/** What a message may contain (Plan 15): plain text, no links, no attachments, nothing hidden in invisible characters. */

export const SUBJECT_MAX = 120;
export const BODY_MAX = 2000;

export type MessageText = { ok: true; subject: string; body: string } | { ok: false; error: string };

// Characters that change how text is drawn or hide it: controls other than tab and line breaks, zero-width and direction marks.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F​‎‏‪-‮⁠⁦-⁩﻿]/;

// Top-level domains common enough that "name.tld" is almost certainly an address, not an abbreviation or a file name.
const TLDS =
  'com|net|org|io|ai|app|dev|co|me|ly|xyz|info|biz|gg|to|tv|sh|cc|ws|fm|im|so|tk|ml|ga|cf|gq|buzz|vip|icu|cam|link|click|top|site|online|shop|store|tech|cloud|email|edu|gov|us|uk|de|fr|ru|cn|in|ch|nl|eu|au|ca|it|es|jp|kr|br|mx|se|no|fi|pl';
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//i;
const SPECIAL = /\b(?:mailto|tel|sms|data|javascript|vbscript|file|ftp|blob|about):(?=\S)/i;
const WWW = /\bwww\./i;
const DOMAIN = new RegExp(`(?:^|[^a-z0-9.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.(?:${TLDS})(?![a-z0-9-])`, 'i');

/**
 * True if the text contains something that works as a link or an address: a scheme (`https://`, `mailto:`), `www.`, or a bare
 * domain with a common ending, which also catches email addresses. Looked at after the text is made plain (full-width dots
 * and letters become ordinary ones, soft hyphens and joiners are dropped), so it cannot be dodged by dressing it up.
 */
export function hasLink(text: string): boolean {
  const plain = text.normalize('NFKC').replace(/[。｡]/g, '.').replace(/[­‌‍]/g, '');
  return SCHEME.test(plain) || SPECIAL.test(plain) || WWW.test(plain) || DOMAIN.test(plain);
}

const length = (text: string) => Array.from(text).length;

/** Checks and tidies a subject and body. The subject is optional. */
export function checkMessageText(subject: unknown, body: unknown): MessageText {
  if ((subject !== undefined && typeof subject !== 'string') || typeof body !== 'string') return { ok: false, error: 'subject and body must be text' };
  const s = (subject ?? '').trim();
  const b = body.trim();
  if (FORBIDDEN.test(s) || FORBIDDEN.test(b) || /[\r\n]/.test(s)) return { ok: false, error: 'text contains characters that are not allowed' };
  if (length(s) > SUBJECT_MAX) return { ok: false, error: `subject must be at most ${SUBJECT_MAX} characters` };
  if (length(b) < 1 || length(b) > BODY_MAX) return { ok: false, error: `body must be 1 to ${BODY_MAX} characters` };
  if (hasLink(s) || hasLink(b)) return { ok: false, error: 'no links' };
  return { ok: true, subject: s, body: b };
}
