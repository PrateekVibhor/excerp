// The published Terms of Use (site/terms/index.html) must match what the app and server do, and link where the app links.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '../../', path), 'utf8');
const html = read('site/terms/index.html');
const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const has = (phrase: string) => text.includes(phrase.toLowerCase());

describe('the terms of use page', () => {
  it('is a finished page: no draft marks, no placeholders, a date, a contact', () => {
    expect(html).not.toMatch(/draft/i);
    expect(text).not.toMatch(/\[[^\]]*\]/);
    expect(html).toMatch(/Last updated: [A-Z][a-z]+ \d{1,2}, 20\d\d/);
    expect(html).toContain('mailto:doer@excerp.app');
    expect(html).toContain('https://excerp.app/privacy');
  });

  it('is the page the app links to', () => {
    expect(read('src/features/readers/links.ts')).toContain("'https://excerp.app/terms'");
  });

  it('uses the app\'s switch names and the numbers the server enforces', () => {
    expect(has('Show me as reading')).toBe(true);
    expect(has('Allow message requests')).toBe(true);
    expect(has('18')).toBe(true);
    expect(has('12 months')).toBe(true);
    expect(has('30 days')).toBe(true);
    expect(has('Deleted account')).toBe(true);
    expect(has('not end-to-end encrypted')).toBe(true);
  });
});
