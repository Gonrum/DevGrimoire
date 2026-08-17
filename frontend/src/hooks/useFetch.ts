import { useState, useEffect, useCallback, useRef } from 'react';
import { errorMessage } from '../lib/narrow';

interface UseFetchResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Lädt `fetcher()` beim Mount und erneut, sobald sich `deps` inhaltlich ändert.
 *
 * Die Signatur ist unverändert (`data`/`loading`/`error`/`refresh`), der Aufbau
 * innen nicht:
 *
 * - `deps` ist ein Array, das der Aufrufer bei jedem Render neu baut. Als
 *   Dependency-Array taugt es deshalb nicht direkt; ein `[...deps]`-Spread lässt
 *   sich statisch nicht prüfen. Stattdessen liegt ein **Snapshot** in State, der
 *   während des Renderns flach mit `deps` verglichen und nur bei echter
 *   Änderung ersetzt wird (React: „Adjusting state when a prop changes").
 * - Der `fetcher` wandert per Effect in eine Ref, statt während des Renderns
 *   zugewiesen zu werden. Der Ref-Effect steht **vor** dem Lade-Effect, läuft
 *   also im selben Commit zuerst — der Ladevorgang sieht immer den neuesten
 *   `fetcher`.
 * - `refresh` ist stabil (`useCallback`) und stösst über einen Zähler denselben
 *   Lade-Effect an, statt einen zweiten Ladepfad zu haben.
 */
export function useFetch<T>(fetcher: () => Promise<T>, initial: T, deps: unknown[] = []): UseFetchResult<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [depsSnapshot, setDepsSnapshot] = useState<unknown[]>(deps);
  if (
    depsSnapshot.length !== deps.length ||
    depsSnapshot.some((value, index) => !Object.is(value, deps[index]))
  ) {
    setDepsSnapshot(deps);
  }

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        setData(await fetcherRef.current());
      } catch (err) {
        setError(errorMessage(err, 'Fehler beim Laden'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [depsSnapshot, reloadToken]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { data, loading, error, refresh };
}
