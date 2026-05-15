import { useEffect, useRef } from 'react';
import { wsEventBus, isProjectChangeEvent, type BusEvent, type ProjectChangeEvent } from '../api/wsEventBus';

export type { ProjectChangeEvent };

type EventHandler = (event: ProjectChangeEvent) => void;

/**
 * 300ms-coalescing wrapper around a WS-bus subscription. Multiple updates to
 * the same entity within the window collapse to one handler call — keeps
 * busy edit flows from triggering a refetch storm.
 */
function useBus(scope: { kind: 'global' | 'project'; projectId?: string } | null, onEvent: EventHandler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!scope) return;
    const pending = new Map<string, ProjectChangeEvent>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsub = wsEventBus.subscribe(scope, (event: BusEvent) => {
      if (!isProjectChangeEvent(event)) return;
      pending.set(event.entity, event);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const events = Array.from(pending.values());
        pending.clear();
        for (const e of events) handlerRef.current(e);
      }, 300);
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      pending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.kind, scope?.projectId]);
}

export function useProjectEvents(
  projectId: string | undefined,
  onEvent: EventHandler,
) {
  useBus(projectId ? { kind: 'project', projectId } : null, onEvent);
}

export function useDashboardEvents(onEvent: EventHandler) {
  useBus({ kind: 'global' }, onEvent);
}
