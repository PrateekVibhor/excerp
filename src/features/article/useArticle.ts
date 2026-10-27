import { useCallback, useEffect, useRef, useState } from 'react';
import { articleRepository, type Article, type ArticleRepository } from '../../data';

export type ArticleStatus = 'loading' | 'ready' | 'notFound' | 'error';

/** Loads one article by id. `notFound` means the source answered but has no such article. */
export function useArticle(id: string | undefined, articles: ArticleRepository = articleRepository) {
  const [status, setStatus] = useState<ArticleStatus>('loading');
  const [article, setArticle] = useState<Article | null>(null);
  const repo = useRef(articles);
  repo.current = articles;
  const latest = useRef(0);

  const load = useCallback(() => {
    const attempt = ++latest.current;
    if (!id) {
      setArticle(null);
      setStatus('notFound');
      return;
    }
    setStatus('loading');
    repo.current
      .getById(id)
      .then((found) => {
        if (attempt !== latest.current) return;
        setArticle(found ?? null);
        setStatus(found ? 'ready' : 'notFound');
      })
      .catch((error) => {
        if (attempt !== latest.current) return;
        console.warn('Could not load the article', id, error);
        setStatus('error');
      });
  }, [id]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  return { status, article, retry: load };
}
