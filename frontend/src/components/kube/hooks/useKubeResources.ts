import { useCallback, useEffect, useRef, useState } from 'react';
import { api, KubeListRow } from '../../../api/client';
import { errorMessage } from '../../../lib/narrow';
import { pollIntervalFor } from '../kubeKinds';

interface Result {
  rows: KubeListRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Lädt eine Ressourcenliste und pollt sie, solange `active` gilt. Der
 * Aufrufer setzt `active` auf false, wenn die Liste nicht sichtbar ist —
 * ein Tab im Hintergrund soll den Cluster nicht befragen.
 *
 * Antworten einer überholten Anfrage werden verworfen: beim schnellen
 * Wechseln zwischen Kinds käme sonst die langsamere Antwort zuletzt an und
 * überschriebe die richtige Liste.
 */
export function useKubeResources(
  clusterId: string,
  kind: string,
  namespace: string | null,
  active: boolean,
): Result {
  const [rows, setRows] = useState<KubeListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    setError(null);
    try {
      const next = await api.listKubeResources(clusterId, {
        kind,
        namespace: namespace ?? undefined,
      });
      if (mine !== requestId.current) return;
      setRows(next);
    } catch (err) {
      if (mine !== requestId.current) return;
      setError(errorMessage(err));
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [clusterId, kind, namespace]);

  /**
   * Reset auf „neue Liste" (leer + lädt), sobald sich Cluster/Kind/Namespace
   * ändern — bewusst während des Renderns statt in einem Effekt: React
   * verwirft in diesem Fall den halbfertigen Render und rendert sofort mit
   * dem zurückgesetzten Zustand neu, ohne den Zwischenstand zu committen
   * (offizielles Muster für „State beim Prop-Wechsel zurücksetzen").
   * `react-hooks/set-state-in-effect` verbietet genau den synchronen
   * `setState`-Aufruf, der vorher hier im Effekt-Body stand — und ein Poll-
   * Tick oder ein manueller `reload()` sollen die Tabelle *nicht* jedes Mal
   * leeren, nur ein echter Filterwechsel.
   */
  const filterKey = `${clusterId}::${kind}::${namespace ?? ''}`;
  const [loadedKey, setLoadedKey] = useState(filterKey);
  if (filterKey !== loadedKey) {
    setLoadedKey(filterKey);
    setLoading(true);
    setRows([]);
  }

  useEffect(() => {
    // Indirektion wie in `useKubeClusters.ts`: ein direkter `void load()` im
    // Effekt-Body lässt `react-hooks/set-state-in-effect` bis in `load`
    // hineinschauen (das synchron `setError(null)` vor dem ersten `await`
    // aufruft) und den Aufruf als „setState direkt im Effekt" flaggen.
    void (async () => { await load(); })();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => {
      // Ein Tab im Hintergrund befragt den Cluster nicht. `active` deckt den
      // Fall „Liste nicht sichtbar" ab, die Sichtbarkeitsprüfung den Fall
      // „Browser-Tab weggeklickt" — sonst pollt ein vergessener Tab stunden-
      // lang durch einen SSH-Tunnel.
      if (document.visibilityState !== 'visible') return;
      void load();
    }, pollIntervalFor(kind));
    return () => window.clearInterval(handle);
  }, [active, kind, load]);

  return { rows, loading, error, reload: load };
}
