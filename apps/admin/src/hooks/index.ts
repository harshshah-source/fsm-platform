import { useCallback, useEffect, useState } from 'react';

export interface ApiResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Standardized data-fetch hook (FE-03). Formalizes the per-page `useEffect` + `alive`-guard pattern so
 * every page gets uniform loading/error handling. `fetcher` is re-run when `deps` change or `refetch`
 * is called. Identity of `fetcher` is intentionally NOT a dependency (callers pass a fresh closure each
 * render); pass everything the fetch varies on via `deps`.
 */
export function useApiResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  errorMsg = 'Failed to load',
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then((r) => {
        if (alive) {
          setData(r);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setError(errorMsg);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refetch };
}

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<void>;
  pending: boolean;
  error: string | null;
}

/**
 * Wraps a mutation so a `Button` can bind `loading={pending}` and surface `error`. Pair with `useToast`
 * at the call site for success/failure feedback.
 */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
  onError = 'Action failed',
): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        await fn(...args);
      } catch (e) {
        setError(e instanceof Error ? e.message : onError);
      } finally {
        setPending(false);
      }
    },
    [fn, onError],
  );
  return { run, pending, error };
}

/** Tiny typed filter-state helper for `FilterBar`-driven pages. */
export function useFilters<T extends Record<string, unknown>>(initial: T) {
  const [filters, setFilters] = useState<T>(initial);
  const set = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => setFilters((f) => ({ ...f, [key]: value })),
    [],
  );
  const reset = useCallback(() => setFilters(initial), [initial]);
  return { filters, set, setFilters, reset };
}
