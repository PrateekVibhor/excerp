import type { ConversationView } from '../../data/socialApi';
import { avatarOf } from '../readers/readerView';

export const NO_SUBJECT = 'No subject';
export const NO_TEXT = 'No message text';

export const subjectOf = (subject: string) => (subject.trim() === '' ? NO_SUBJECT : subject.trim());

/** The first paragraph of a message, or null when there is no text at all. */
export function firstParagraph(body: string): string | null {
  const paragraph = body.split(/\n\s*\n/).find((p) => p.trim() !== '');
  return paragraph === undefined ? null : paragraph.trim().replace(/\s+/g, ' ');
}

export const previewOf = (body: string) => firstParagraph(body) ?? NO_TEXT;

/** The header line above the title: "2 UNREAD · 5 CONVERSATIONS", "5 CONVERSATIONS", or "NOTHING HERE YET". */
export function inboxKicker(total: number, unread: number): string {
  if (total === 0) return 'NOTHING HERE YET';
  const things = `${total} ${total === 1 ? 'CONVERSATION' : 'CONVERSATIONS'}`;
  return unread > 0 ? `${unread} UNREAD · ${things}` : things;
}

export interface Sender {
  name: string;
  /** Null when not known, for instance a deleted account. */
  industry: string | null;
  initials: string;
  tone: 0 | 1 | 2;
  /** The reader's public id, or null when there is no profile to open (a deleted account). */
  publicId: string | null;
}

/** Who the other person in a conversation is. */
export function otherOf(c: Pick<ConversationView, 'id' | 'other'>): Sender {
  const o = c.other;
  if (o.deleted || o.public_id === null) return { name: o.display_name, industry: null, initials: '?', tone: 0, publicId: null };
  return { name: o.display_name, industry: o.industry, ...avatarOf(o.display_name, o.public_id), publicId: o.public_id };
}

/** The words under a conversation's name, for the ones that are not a normal back-and-forth. */
export function stateNote(c: Pick<ConversationView, 'state' | 'role'>): string | null {
  if (c.role === 'initiator' && c.state === 'pending') return 'Waiting for a reply';
  if (c.state === 'expired') return 'Expired';
  return null;
}
