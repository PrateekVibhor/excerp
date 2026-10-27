import { createMockRepositories } from '../../data/mockRepository';
import { SOURCE_COMPANIES } from '../../data/types';
import { formatPublishedDate, monograms, readersLabel, sourceDomain } from './cardFormat';

describe('formatPublishedDate', () => {
  it('formats as "Sep 24"', () => {
    expect(formatPublishedDate('2026-09-24T09:00:00Z')).toBe('Sep 24');
    expect(formatPublishedDate('2026-10-02T17:30:00Z')).toBe('Oct 2');
  });

  it('uses UTC so late-evening UTC times keep their day', () => {
    expect(formatPublishedDate('2026-09-24T23:59:00Z')).toBe('Sep 24');
    expect(formatPublishedDate('2026-01-01T00:00:00Z')).toBe('Jan 1');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatPublishedDate('not a date')).toBe('');
  });
});

describe('sourceDomain', () => {
  it('keeps the last two labels of the host', () => {
    expect(sourceDomain('https://www.anthropic.com/research')).toBe('anthropic.com');
    expect(sourceDomain('https://research.nvidia.com/')).toBe('nvidia.com');
    expect(sourceDomain('https://nvidianews.nvidia.com/')).toBe('nvidia.com');
    expect(sourceDomain('https://aws.amazon.com/blogs/machine-learning/')).toBe('amazon.com');
  });

  it('leaves two-label hosts alone', () => {
    expect(sourceDomain('https://research.google/')).toBe('research.google');
    expect(sourceDomain('https://blog.google/technology/ai/')).toBe('blog.google');
    expect(sourceDomain('https://openai.com/news/')).toBe('openai.com');
  });

  it('ignores port, query and case', () => {
    expect(sourceDomain('HTTPS://Example.COM:8080/a?b=c')).toBe('example.com');
  });

  it('returns an empty string for something that is not a URL', () => {
    expect(sourceDomain('nope')).toBe('');
  });

  it('keeps every mock article domain short enough for the card header', async () => {
    const feed = await createMockRepositories().articles.getFeed('u');
    expect(feed.length).toBeGreaterThan(0);
    for (const a of feed) {
      const domain = sourceDomain(a.source_url);
      expect(domain).not.toBe('');
      expect(domain.length).toBeLessThanOrEqual(15);
    }
  });
});

describe('readersLabel', () => {
  it('pluralizes', () => {
    expect(readersLabel(128)).toBe('128 people are reading this');
    expect(readersLabel(1)).toBe('1 person is reading this');
  });
});

describe('monograms', () => {
  it('has one for every company', () => {
    for (const c of SOURCE_COMPANIES) expect(monograms[c]).toBeTruthy();
  });
});
