import { useEffect, useRef } from 'react';

export interface ProjectChangeEvent {
  projectId: string;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
}

type EventHandler = (event: ProjectChangeEvent) => void;

function useSSE(url: string | null, onEvent: EventHandler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingRef = useRef<Map<string, ProjectChangeEvent>>(new Map());

  useEffect(() => {
    if (!url) return;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (msg) => {
      const event: ProjectChangeEvent = JSON.parse(msg.data);
      pendingRef.current.set(event.entity, event);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const events = Array.from(pendingRef.current.values());
        pendingRef.current.clear();
        events.forEach((e) => handlerRef.current(e));
      }, 300);
    };

    return () => {
      eventSource.close();
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingRef.current.clear();
    };
  }, [url]);
}

export function useProjectEvents(
  projectId: string | undefined,
  onEvent: EventHandler,
) {
  useSSE(
    projectId ? `/api/events?projectId=${projectId}` : null,
    onEvent,
  );
}

export function useDashboardEvents(onEvent: EventHandler) {
  useSSE('/api/events', onEvent);
}
