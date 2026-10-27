import { mockArticles } from './mockArticles';
import type { ArticleRepository, ReadingListRepository } from './repository';
import type { ReadingListItem, SwipeEvent } from './types';

/** Fresh in-memory repositories sharing one swipe log. Each call starts empty. */
export function createMockRepositories(): {
  articles: ArticleRepository;
  readingList: ReadingListRepository;
} {
  const swipes: SwipeEvent[] = [];
  // Insertion order is save order, so newest-first is just the reverse.
  let saved: ReadingListItem[] = [];
  let nextId = 1;

  const articles: ArticleRepository = {
    async getFeed(userId) {
      const swiped = new Set(
        swipes.filter((s) => s.user_id === userId).map((s) => s.article_id),
      );
      return mockArticles.filter((a) => !swiped.has(a.id));
    },
    async getById(id) {
      return mockArticles.find((a) => a.id === id);
    },
  };

  const readingList: ReadingListRepository = {
    async list(userId) {
      return saved.filter((i) => i.user_id === userId).reverse();
    },
    async add(userId, articleId) {
      const existing = saved.find((i) => i.user_id === userId && i.article_id === articleId);
      if (existing) return existing;
      const item: ReadingListItem = {
        id: `rl-${nextId++}`,
        user_id: userId,
        article_id: articleId,
        saved_at: new Date().toISOString(),
      };
      saved.push(item);
      return item;
    },
    async remove(userId, articleId) {
      saved = saved.filter((i) => !(i.user_id === userId && i.article_id === articleId));
    },
    async recordSwipe(event) {
      swipes.push(event);
    },
  };

  return { articles, readingList };
}
