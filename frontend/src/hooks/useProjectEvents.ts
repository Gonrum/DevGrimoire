import { useEffect, useRef } from 'react';
import {
  wsEventBus,
  isProjectChangeEvent,
  type BusEvent,
  type ProjectChangeEvent,
  type SubscriptionScope,
} from '../api/wsEventBus';

export type { ProjectChangeEvent };

type EventHandler = (event: ProjectChangeEvent) => void;

/**
 * 300ms-coalescing wrapper around a WS-bus subscription. Multiple updates to
 * the same entity within the window collapse to one handler call — keeps
 * busy edit flows from triggering a refetch storm.
 */
function useBus(kind: 'global' | 'project' | null, projectId: string | undefined, onEvent: EventHandler) {
  // Ref-Zuweisung im Effect statt im Render: der Handler wird ohnehin erst
  // nach dem Commit aufgerufen (frühestens 300ms später im Timer).
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  /*
   * Abhängig sind die beiden Primitiven, nicht das Scope-Objekt: die Aufrufer
   * bauen es bei jedem Render neu, als Dependency wäre es bei jedem Render
   * „geändert" und das Abo würde ständig neu aufgebaut. Vorher stand genau
   * deshalb ein abgeschaltetes `exhaustive-deps` über dem Array.
   */
  useEffect(() => {
    if (!kind) return;
    const scope: SubscriptionScope = kind === 'project' ? { kind, projectId } : { kind };
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
  }, [kind, projectId]);
}

export function useProjectEvents(
  projectId: string | undefined,
  onEvent: EventHandler,
) {
  useBus(projectId ? 'project' : null, projectId, onEvent);
}

export function useDashboardEvents(onEvent: EventHandler) {
  useBus('global', undefined, onEvent);
}
