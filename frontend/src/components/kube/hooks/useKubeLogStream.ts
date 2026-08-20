import { useCallback, useEffect, useState } from 'react';
import { getCurrentAccessToken } from '../../../api/client';
import i18n from '../../../i18n';
import { isRecord } from '../../../lib/narrow';

interface Args {
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  follow: boolean;
  enabled: boolean;
}

interface Result {
  lines: string[];
  connected: boolean;
  error: string | null;
  clear: () => void;
}

const MAX_LINES = 2000;

/**
 * Hängt sich an die SSE-Route für Pod-Logs. `EventSource` kann keine
 * Authorization-Kopfzeile setzen, deshalb geht das Token als Query-Parameter
 * — `JwtAuthGuard` akzeptiert `?token=` explizit für SSE-Routen, und
 * `LogsQueryDto.token` ist als ignoriertes Feld deklariert, damit die
 * globale ValidationPipe ihn nicht als unbekanntes Feld ablehnt.
 *
 * Der Puffer ist auf MAX_LINES begrenzt: ein folgender Stream auf einem
 * gesprächigen Pod würde den Browser sonst über Stunden vollschreiben.
 */
export function useKubeLogStream(args: Args): Result {
  const { clusterId, namespace, pod, container, follow, enabled } = args;
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => setLines([]), []);

  // Reset auf „neuer Stream", sobald sich Ziel-Pod/-Container oder der
  // Follow-Schalter ändern — während des Renderns, nicht im Effekt
  // (gleiches Muster wie `useKubeResources.ts`): React verwirft dann den
  // halbfertigen Render und committet direkt den zurückgesetzten Zustand.
  // `react-hooks/set-state-in-effect` verbietet den synchronen
  // `setState`-Aufruf, der dafür vorher im Effekt-Body stand.
  const streamKey = `${clusterId}::${namespace}::${pod}::${container ?? ''}::${String(follow)}::${String(enabled)}`;
  const [loadedStreamKey, setLoadedStreamKey] = useState(streamKey);
  if (streamKey !== loadedStreamKey) {
    setLoadedStreamKey(streamKey);
    setError(null);
    setLines([]);
  }

  useEffect(() => {
    if (!enabled) return;

    const q = new URLSearchParams({ namespace, pod, tailLines: '200' });
    if (container) q.set('container', container);
    if (follow) q.set('follow', 'true');
    const token = getCurrentAccessToken();
    if (token) q.set('token', token);

    const source = new EventSource(`/api/kube-clusters/${clusterId}/logs/stream?${q.toString()}`);

    // `connected` erst über `onopen` setzen statt sofort nach dem
    // Konstruktor: die Reaktion auf ein Ereignis des externen Systems
    // (Verbindung tatsächlich offen), nicht eine Annahme, sobald das
    // `EventSource`-Objekt existiert.
    source.onopen = () => setConnected(true);

    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (!isRecord(parsed)) return;
        if (parsed.type === 'line' && typeof parsed.line === 'string') {
          const line = parsed.line;
          setLines((prev) => {
            const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
            return [...next, line];
          });
        } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
          // Der Server schliesst die Verbindung nach JEDEM Abschluss —
          // auch nach einem sauberen `done`. Ohne das sofortige `close()`
          // hier würde der native `onerror`-Handler unten den Verbindungs-
          // abbau als eigenen Netzwerkfehler werten, sich neu verbinden
          // wollen und dabei die aussagekräftige Server-Meldung mit der
          // generischen Fallback-Meldung überschreiben. Ein abgebrochener
          // Stream darf nicht wie ein sauberes Ende aussehen — deshalb hier
          // explizit als getrennt markieren statt den Reconnect laufen zu
          // lassen.
          setError(parsed.message);
          setConnected(false);
          source.close();
        } else if (parsed.type === 'done') {
          setConnected(false);
          source.close();
        }
      } catch {
        // Eine unlesbare Zeile darf den Stream nicht beenden.
      }
    };

    source.onerror = () => {
      setConnected(false);
      setError(i18n.t('kube.drawer.streamLost'));
      source.close();
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [clusterId, namespace, pod, container, follow, enabled]);

  return { lines, connected, error, clear };
}
