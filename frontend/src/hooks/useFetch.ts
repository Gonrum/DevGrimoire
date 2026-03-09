import { useState, useEffect, useCallback, useRef } from 'react';

interface UseFetchResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFetch<T>(fetcher: () => Promise<T>, initial: T, deps: unknown[] = []): UseFetchResult<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcherRef.current()
      .then(setData)
      .catch((err) => setError(err.message || 'Fehler beim Laden'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
