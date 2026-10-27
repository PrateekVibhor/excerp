import * as fs from 'fs';
import * as path from 'path';
import { mockArticles } from './mockArticles';
import { createMockRepositories } from './mockRepository';
import { CONTENT_TYPES, INTERESTS, SOURCE_COMPANIES } from './types';

const USER = 'user-1';
const swipe = (article_id: string, direction: 'left' | 'right', user_id = USER) => ({
  user_id,
  article_id,
  direction,
  swiped_at: '2026-10-03T10:00:00Z',
});

describe('mock article set', () => {
  it('holds between 8 and 10 articles', () => {
    expect(mockArticles.length).toBeGreaterThanOrEqual(8);
    expect(mockArticles.length).toBeLessThanOrEqual(10);
  });

  it('covers every content type', () => {
    const present = new Set(mockArticles.map((a) => a.content_type));
    for (const type of CONTENT_TYPES) expect(present.has(type)).toBe(true);
  });

  it('uses at least five different companies, all valid', () => {
    const companies = new Set(mockArticles.map((a) => a.source_company));
    expect(companies.size).toBeGreaterThanOrEqual(5);
    for (const c of companies) expect(SOURCE_COMPANIES).toContain(c);
  });

  it('has unique ids', () => {
    expect(new Set(mockArticles.map((a) => a.id)).size).toBe(mockArticles.length);
  });

  it.each(mockArticles.map((a) => [a.id, a.summary] as const))(
    'summary of %s has between 50 and 60 words',
    (_id, summary) => {
      const words = summary.trim().split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(50);
      expect(words).toBeLessThanOrEqual(60);
    },
  );
});

describe('ArticleRepository', () => {
  it('returns every article when nothing has been swiped', async () => {
    const { articles } = createMockRepositories();
    expect(await articles.getFeed(USER)).toHaveLength(mockArticles.length);
  });

  it('excludes swiped articles, whichever direction', async () => {
    const { articles, readingList } = createMockRepositories();
    await readingList.recordSwipe(swipe('mock-1', 'right'));
    await readingList.recordSwipe(swipe('mock-2', 'left'));
    const ids = (await articles.getFeed(USER)).map((a) => a.id);
    expect(ids).not.toContain('mock-1');
    expect(ids).not.toContain('mock-2');
    expect(ids).toHaveLength(mockArticles.length - 2);
  });

  it('keeps swipes per user', async () => {
    const { articles, readingList } = createMockRepositories();
    await readingList.recordSwipe(swipe('mock-1', 'right'));
    expect(await articles.getFeed('user-2')).toHaveLength(mockArticles.length);
  });

  it('getById finds an article and returns undefined for an unknown id', async () => {
    const { articles } = createMockRepositories();
    expect((await articles.getById('mock-3'))?.id).toBe('mock-3');
    expect(await articles.getById('nope')).toBeUndefined();
  });
});

describe('ReadingListRepository', () => {
  it('lists newest first', async () => {
    const { readingList } = createMockRepositories();
    await readingList.add(USER, 'mock-1');
    await readingList.add(USER, 'mock-2');
    const ids = (await readingList.list(USER)).map((i) => i.article_id);
    expect(ids).toEqual(['mock-2', 'mock-1']);
  });

  it('does not duplicate an article that is already saved', async () => {
    const { readingList } = createMockRepositories();
    await readingList.add(USER, 'mock-1');
    await readingList.add(USER, 'mock-1');
    expect(await readingList.list(USER)).toHaveLength(1);
  });

  it('removes an item', async () => {
    const { readingList } = createMockRepositories();
    await readingList.add(USER, 'mock-1');
    await readingList.add(USER, 'mock-2');
    await readingList.remove(USER, 'mock-1');
    const ids = (await readingList.list(USER)).map((i) => i.article_id);
    expect(ids).toEqual(['mock-2']);
  });

  it('keeps lists per user', async () => {
    const { readingList } = createMockRepositories();
    await readingList.add(USER, 'mock-1');
    expect(await readingList.list('user-2')).toEqual([]);
  });
});

describe('encapsulation', () => {
  const root = path.resolve(__dirname, '../..');
  const dataDir = path.join(root, 'src', 'data');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it('only files in src/data import mockArticles', () => {
    const offenders = ['app', 'src']
      .flatMap((d) => sourceFiles(path.join(root, d)))
      .filter((file) => !file.startsWith(dataDir + path.sep))
      // The end-to-end flow-data test (spec 12) reads the raw sample articles on purpose, to check the flows against them. It is not app code.
      .filter((file) => !file.startsWith(path.join(root, 'src', 'e2e') + path.sep))
      .filter((file) => /from\s+['"][^'"]*mockArticles['"]/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('index.ts does not export the raw mock array', () => {
    const index = fs.readFileSync(path.join(dataDir, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/mockArticles/);
  });

  describe('quizzes', () => {
    const withQuiz = mockArticles.filter((a) => a.quiz);

    it('three mock articles carry a quiz, so the quiz can be tried without the server', () => {
      expect(withQuiz).toHaveLength(3);
      expect(new Set(withQuiz.map((a) => a.source_company)).size).toBe(3);
    });

    it.each(withQuiz.map((a) => [a.id, a] as const))('%s: the quiz follows the pipeline rules', (_id, a) => {
      expect(a.quiz!.questions).toHaveLength(3);
      for (const q of a.quiz!.questions) {
        expect(q.prompt.length).toBeGreaterThan(0);
        expect(q.prompt.length).toBeLessThanOrEqual(140);
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options.map((o) => o.toLowerCase())).size).toBe(4);
        for (const o of q.options) {
          expect(o.length).toBeGreaterThan(0);
          expect(o.length).toBeLessThanOrEqual(80);
        }
        expect(Number.isInteger(q.correct_index)).toBe(true);
        expect(q.correct_index).toBeGreaterThanOrEqual(0);
        expect(q.correct_index).toBeLessThanOrEqual(3);
        expect(q.prompt).not.toMatch(/the summary|according to/i);
        // the right answer must not give itself away by length (the pipeline rejects more than 1.5 times the longest wrong one)
        const wrongLongest = Math.max(...q.options.filter((_, i) => i !== q.correct_index).map((o) => o.length));
        const right = q.options[q.correct_index].length;
        expect(right > 1.5 * wrongLongest && right - wrongLongest >= 8).toBe(false);
      }
      expect(INTERESTS).toContain(a.topic);
    });

    it('the right answers are not all in the same place', () => {
      expect(new Set(withQuiz.flatMap((a) => a.quiz!.questions.map((q) => q.correct_index))).size).toBeGreaterThan(1);
    });

    it('the other mock articles have no quiz', () => {
      expect(mockArticles.filter((a) => !a.quiz)).toHaveLength(mockArticles.length - 3);
    });
  });
});
