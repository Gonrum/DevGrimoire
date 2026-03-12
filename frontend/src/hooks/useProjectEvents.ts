import { useEffect, useRef } from 'react';
import { useAuth } from './useAuth';

export interface ProjectChangeEvent {
  projectId: string;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'environment' | 'secret' | 'schema' | 'dependency' | 'feature' | 'soul';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
}

type EventHandler = (event: ProjectChangeEvent) => void;

function useSSE(url: string | null, onEvent: EventHandler, token: string | null) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingRef = useRef<Map<string, ProjectChangeEvent>>(new Map());

  useEffect(() => {
    if (!url) return;

    const sep = url.includes('?') ? '&' : '?';
    const fullUrl = token ? `${url}${sep}token=${token}` : url;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;

    function connect() {
      es = new EventSource(fullUrl);

      es.onopen = () => {
        retryDelay = 1000;
      };

      es.onmessage = (msg) => {
        const event: ProjectChangeEvent = JSON.parse(msg.data);
        pendingRef.current.set(event.entity, event);

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          const events = Array.from(pendingRef.current.values());
          pendingRef.current.clear();
          events.forEach((e) => handlerRef.current(e));
        }, 300);
      };

      es.onerror = () => {
        es?.close();
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingRef.current.clear();
    };
  }, [url, token]);
}

export function useProjectEvents(
  projectId: string | undefined,
  onEvent: EventHandler,
) {
  const { getAccessToken } = useAuth();
  useSSE(
    projectId ? `/api/events?projectId=${projectId}` : null,
    onEvent,
    getAccessToken(),
  );
}

export function useDashboardEvents(onEvent: EventHandler) {
  const { getAccessToken } = useAuth();
  useSSE('/api/events', onEvent, getAccessToken());
}
