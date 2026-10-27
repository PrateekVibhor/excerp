import { firstParagraph, inboxKicker, NO_SUBJECT, NO_TEXT, otherOf, previewOf, stateNote, subjectOf } from './inboxText';
import { conversation } from '../readers/testing';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

describe('subjectOf', () => {
  it('shows the subject, trimmed, or "No subject" when empty or blank', () => {
    expect(subjectOf('  Coffee in SF next week?  ')).toBe('Coffee in SF next week?');
    expect(subjectOf('')).toBe(NO_SUBJECT);
    expect(subjectOf('   ')).toBe('No subject');
  });
});

describe('previewOf', () => {
  it('is the first paragraph of the message, joined to one line', () => {
    expect(previewOf('First paragraph.\n\nSecond paragraph.')).toBe('First paragraph.');
    expect(previewOf('Hello\nthere   friend.\n\nNext')).toBe('Hello there friend.');
    expect(previewOf('\n\n  \n\nReal text\n\nMore')).toBe('Real text');
  });
  it('reads "No message text" when there is no text at all', () => {
    expect(previewOf('')).toBe(NO_TEXT);
    expect(previewOf('  \n\n \n ')).toBe('No message text');
    expect(firstParagraph('')).toBeNull();
  });
});

describe('inboxKicker', () => {
  it('lists unread and total, the unread first', () => {
    expect(inboxKicker(5, 2)).toBe('2 UNREAD · 5 CONVERSATIONS');
    expect(inboxKicker(5, 0)).toBe('5 CONVERSATIONS');
    expect(inboxKicker(1, 0)).toBe('1 CONVERSATION');
    expect(inboxKicker(1, 1)).toBe('1 UNREAD · 1 CONVERSATION');
  });
  it('says there is nothing for an empty inbox', () => {
    expect(inboxKicker(0, 0)).toBe('NOTHING HERE YET');
  });
});

describe('otherOf', () => {
  it('describes the other reader, with initials and a color from their public id', () => {
    const o = otherOf(conversation(1));
    expect(o).toMatchObject({ name: 'Reader 1', industry: 'Software', initials: 'R1', publicId: '00000000-0000-4000-8000-000000000001' });
    expect([0, 1, 2]).toContain(o.tone);
  });
  it('Scenario: a deleted account has a name and nothing to open', () => {
    const gone = conversation(2, { other: { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true } });
    expect(otherOf(gone)).toEqual({ name: 'Deleted account', industry: null, initials: '?', tone: 0, publicId: null });
  });
});

describe('stateNote', () => {
  it('says only what the sender may know: waiting, or expired - never a decline', () => {
    expect(stateNote({ role: 'initiator', state: 'pending' })).toBe('Waiting for a reply');
    expect(stateNote({ role: 'initiator', state: 'expired' })).toBe('Expired');
    expect(stateNote({ role: 'recipient', state: 'request' })).toBeNull();
    expect(stateNote({ role: 'initiator', state: 'open' })).toBeNull();
  });
});
