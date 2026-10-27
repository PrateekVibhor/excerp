import { useCallback, useEffect, useRef, useState } from 'react';
import { verifiedRepository, type VerifiedRepository } from '../../data';

/**
 * The ids of every article the reader has passed the quiz for, kept up to date as records are added.
 * `ready` turns true once the store has answered, so a screen can wait before deciding what to show.
 * An unreadable store gives an empty set: no badges, no crash.
 */
export function useVerifiedSet(repository: VerifiedRepository = verifiedRepository) {
  const [state, setState] = useState<{ ids: ReadonlySet<string>; ready: boolean }>({ ids: new Set(), ready: false });
  const repo = useRef(repository);
  repo.current = repository;
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const attempt = ++latest.current;
    repo.current.list().then((records) => {
      if (attempt === latest.current) setState({ ids: new Set(records.map((r) => r.article_id)), ready: true });
    });
  }, []);

  useEffect(() => {
    refresh();
    const off = repo.current.subscribe(refresh);
    return () => {
      latest.current++;
      off();
    };
  }, [refresh]);

  return state;
}

/** Whether the reader has passed this article's quiz. False until known, and when the store cannot be read. */
export function useVerified(articleId: string | undefined, repository: VerifiedRepository = verifiedRepository) {
  const { ids } = useVerifiedSet(repository);
  return articleId !== undefined && ids.has(articleId);
}

/** The same, with `ready`: false until the store has answered. */
export function useVerifiedState(articleId: string | undefined, repository: VerifiedRepository = verifiedRepository) {
  const { ids, ready } = useVerifiedSet(repository);
  return { verified: articleId !== undefined && ids.has(articleId), ready };
}
