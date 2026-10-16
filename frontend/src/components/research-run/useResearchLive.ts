import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { applyLiveEvent, emptyLive, type LiveState } from '../../lib/research';

/**
 * Live-Lanes einer laufenden Recherche über SSE.
 *
 * `EventSource` verbindet sich nach einem Abbruch von selbst neu. Das wollen wir
 * nicht: nach `end` ist der Lauf vorbei, und bei einem Fehler (Backend-Neustart,
 * Proxy-Timeout) übernimmt das Polling der Seite. Deshalb `close()` in beiden
 * Fällen; die Seite schaltet `enabled` wieder ein, sobald der Status erneut aktiv ist.
 */
export function useResearchLive(id: string, enabled: boolean, onEnd: () => void): LiveState {
  const [live, setLive] = useState<LiveState>(emptyLive);
  const onEndRef = useRef(onEnd);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(api.research.liveUrl(id));
    source.onmessage = (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      setLive((prev) => applyLiveEvent(prev, parsed));
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed && parsed.type === 'end') {
        source.close();
        onEndRef.current();
      }
    };
    source.onerror = () => {
      source.close();
      setLive((prev) => applyLiveEvent(prev, { type: 'end' }));
      onEndRef.current();
    };
    return () => source.close();
  }, [id, enabled]);

  return live;
}
