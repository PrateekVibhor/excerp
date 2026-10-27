// The published privacy policy (site/privacy/index.html) must say what the app and server actually do, in the words the app uses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(__dirname, '../../site/privacy/index.html'), 'utf8');
const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&copy;/g, '(c)').replace(/\s+/g, ' ');
const lower = text.toLowerCase();
const has = (phrase: string) => lower.includes(phrase.toLowerCase());
const component = (path: string) => readFileSync(join(__dirname, '../../', path), 'utf8');

describe('the privacy policy page', () => {
  it('is well formed and keeps the pieces other things link to', () => {
    expect(html.match(/id="delete-account"/g)).toHaveLength(1); // the Play Store deletion URL ends in #delete-account
    expect(html).toContain('mailto:doer@excerp.app');
    expect(html).toMatch(/Last updated: [A-Z][a-z]+ \d{1,2}, 20\d\d/);
    const open = (html.match(/<(ul|li|p|h2|main|div)\b/g) ?? []).length;
    const close = (html.match(/<\/(ul|li|p|h2|main|div)>/g) ?? []).length;
    expect(open).toBe(close);
  });

  it('Scenario: says everything the server now keeps, tied to the account', () => {
    for (const phrase of [
      'Google or Apple account ID', 'account reference', 'display name', 'industry', 'topics', 'saved articles', 'verified articles',
      'skip', 'count', 'leaderboard', 'London', '30 days', '35 days', 'one-way',
    ]) expect(has(phrase)).toBe(true);
  });

  it('Scenario: tells the reader when their data starts being saved, and that skips are counted from sign-in', () => {
    expect(has('complete your profile')).toBe(true);
    expect(has('verify your first article')).toBe(true);
    expect(has('already using Excerp')).toBe(true);
    expect(has('from the moment you sign in')).toBe(true);
  });

  it('Scenario: gives the reason skips are counted, in the words the owner chose', () => {
    expect(has("To improve your experience by avoiding content you've shown you're not interested in")).toBe(true);
    expect(has('so we can improve the content')).toBe(false); // the earlier wording
  });

  it('Scenario: what stays on the phone is only what really does', () => {
    expect(has('quiz answers')).toBe(true);
    expect(has('Your messages are kept on our server, not on your phone')).toBe(true);
    expect(has('order')).toBe(true); // skips are kept as counts on the server, not in the order they were swiped
  });

  it('no longer says what used to be true and is not: that the reading list, badges or profile are never received', () => {
    for (const stale of ['We never receive them', 'stored only on your phone', 'save articles to a reading list on your phone', 'Your profile (name, industry and topics), your reading list']) expect(has(stale)).toBe(false);
  });

  it('Scenario: the deletion section offers the app first and email second, and says how the phone\'s copy is handled', () => {
    const section = text.slice(text.indexOf('Delete your Excerp account', text.indexOf('Data retention')));
    expect(section.indexOf('In the app')).toBeGreaterThan(-1);
    expect(section.indexOf('In the app')).toBeLessThan(section.indexOf('By email'));
    expect(section).toContain('Delete account');
    expect(section.toLowerCase()).toContain('remove it from your phone');
    expect(section.toLowerCase()).toContain('keep');
    expect(section).toContain('account reference');
  });

  it('Scenario: lists as removed exactly what the app\'s confirmation lists', () => {
    const confirmation = component('src/features/auth/DeleteAccountRow.tsx');
    for (const item of ['email address', 'profile', 'saved articles', 'verified articles', 'skip counts', 'leaderboard entries', 'sign-in sessions']) {
      expect(confirmation).toContain(item);
      expect(has(item)).toBe(true);
    }
  });

  it('says what the app\'s notices say, so a reader is never told one thing in the app and another here', () => {
    const notice = component('src/features/auth/SyncNotice.tsx');
    expect(notice).toContain("Other readers see only your leaderboard name and your number of verified articles");
    expect(has('only your leaderboard name and your number of verified articles')).toBe(true);
    const signIn = component('src/features/auth/SignInNotice.tsx');
    expect(signIn).toContain('counts the articles you skip');
    expect(has('counts how many times you skipped each article')).toBe(true);
  });

  it('Scenario: the delete screen and the policy both say that messages already sent stay with the readers they were sent to', () => {
    expect(component('src/features/auth/DeleteAccountRow.tsx')).toContain('Messages you sent stay with the readers you sent them to, without your name');
    expect(has('Messages you sent stay with the readers you sent them to, without your name')).toBe(true);
  });

  it('Scenario: explains being seen and messaging, in the labels the app uses', () => {
    for (const label of ['Show me as reading', 'Allow message requests']) {
      expect(has(label)).toBe(true);
      expect(component('src/features/readers/MessagingSettingsCard.tsx') + component('src/features/readers/ConfirmVisibilitySheet.tsx')).toContain(label);
    }
    for (const phrase of ['18 or older', 'not end-to-end encrypted', 'text only', 'Blocks', 'Reports', '12 months', '90 days', 'Deleted account']) expect(has(phrase)).toBe(true);
    expect(html).toContain('href="https://excerp.app/terms"');
  });

  it('Scenario: names Sign in with Apple beside Google: the hidden-email address, the account ID, separate accounts, the deletion code and what is revoked', () => {
    for (const phrase of [
      'sign in with Google or with Apple', 'private relay address', 'privaterelay.appleid.com', 'asks Apple for your email address only',
      'A Google account and an Apple account are separate accounts', 'never merged',
      'one-way scrambled code of its Google or Apple account ID', 'sign in with Apple once more', 'end the app\'s access', 'We keep nothing from Apple after that',
      'Excerp offers Sign in with Apple',
    ]) expect(has(phrase)).toBe(true);
    expect(html).toContain('href="https://www.apple.com/legal/privacy/"');
    expect(has('your Google account ID')).toBe(false); // always "Google or Apple account ID" now
  });

  it('Scenario: still says nothing about the account is sent to the AI and search services, now for Apple as well', () => {
    expect(has('We do not send your name, email address, Google or Apple account ID or account reference to any of these')).toBe(true);
  });

  it('Scenario: the sign-in screen\'s notice and the account-reference text say "Google or Apple", as the policy does', () => {
    expect(component('src/features/auth/SignInNotice.tsx')).toContain('tied to your Google or Apple account');
    expect(component('src/features/auth/AccountReference.tsx')).toContain('does not reveal your Google or Apple account details');
  });

  it('Scenario: the Terms say the same of the sign-in', () => {
    const terms = readFileSync(join(__dirname, '../../site/terms/index.html'), 'utf8');
    expect(terms).toContain('Keep your Google or Apple account secure.');
    expect(terms).toContain('your Google or Apple account or your reference code');
    expect(terms).toContain('Last updated: October 23, 2026');
    expect(html).toContain('Last updated: October 23, 2026');
  });
});
