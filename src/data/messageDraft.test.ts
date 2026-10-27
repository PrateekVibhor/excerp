import { looksLikeLink, replySubject, validateDraft } from './messageDraft';

describe('replySubject', () => {
  it('puts "Re: " in front, once, and never in front of nothing', () => {
    expect(replySubject('Your take')).toBe('Re: Your take');
    expect(replySubject('Re: Your take')).toBe('Re: Your take');
    expect(replySubject('RE: x')).toBe('RE: x');
    expect(replySubject('   ')).toBe('');
  });
  it('is cut to 120 characters', () => {
    expect(Array.from(replySubject('x'.repeat(200))).length).toBeLessThanOrEqual(120);
  });
});

describe('validateDraft', () => {
  it('a message needs text, at most 2000 characters; a subject is optional, at most 120', () => {
    expect(validateDraft({ subject: '', body: 'Hi' })).toEqual({});
    expect(validateDraft({ subject: '', body: '  ' }).body).toBeDefined();
    expect(validateDraft({ subject: 'x'.repeat(121), body: 'Hi' }).subject).toBeDefined();
    expect(validateDraft({ subject: 'x'.repeat(120), body: 'b'.repeat(2000) })).toEqual({});
    expect(validateDraft({ subject: '', body: 'b'.repeat(2001) }).body).toBeDefined();
    expect(validateDraft({ subject: '😀'.repeat(120), body: '😀'.repeat(2000) })).toEqual({});
  });
});

describe('looksLikeLink', () => {
  it('catches the obvious ones and leaves ordinary writing alone', () => {
    for (const bad of ['see https://x.y', 'www.thing.net', 'visit acme.io', 'me@example.com']) expect(looksLikeLink(bad)).toBe(true);
    for (const fine of ['Node.js and Next.js', 'version 1.2.3', 'e.g. this', 'about 3.5 times']) expect(looksLikeLink(fine)).toBe(false);
  });
});
