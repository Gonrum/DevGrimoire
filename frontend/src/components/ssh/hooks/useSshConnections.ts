import { useCallback, useEffect, useRef, useState } from 'react';
import { api, SshConnectionListItem } from '../../../api/client';
import { isProjectChangeEvent, wsEventBus } from '../../../api/wsEventBus';

export interface UseSshConnectionsScope {
  customerId?: string;
  projectId?: string;
}

interface UseSshConnectionsResult {
  data: SshConnectionListItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** `isActive` for callers that always want the result applied — see `load`. */
const ALWAYS_ACTIVE = () => true;

/**
 * Lists SSH connections for the given scope. Exactly one of `customerId` or
 * `projectId` must be set (mirrors backend `/api/customers/:id/ssh-connections`
 * and `/api/projects/:id/ssh-connections`).
 *
 * Implementation note: the rest of the codebase doesn't use react-query, so
 * this hook follows the same plain-state pattern as `MonitoringTab`. T-385
 * wires live updates by subscribing to ssh-connection events on the WS
 * multiplex bus — every relevant event coalesces into a debounced `reload()`
 * so two browser tabs stay in sync without polling.
 */
export function useSshConnections(scope: UseSshConnectionsScope): UseSshConnectionsResult {
  const { customerId, projectId } = scope;
  const [data, setData] = useState<SshConnectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * `isActive` gates the state write: the scope can switch (customer tab →
   * project tab) while a list request is still in flight, and the older
   * answer must not overwrite the newer scope's list.
   */
  const load = useCallback(
    async (isActive: () => boolean) => {
      if (!customerId && !projectId) {
        setData([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = customerId
          ? await api.ssh.listForCustomer(customerId)
          : await api.ssh.listForProject(projectId!);
        if (isActive()) setData(list);
      } catch (err) {
        if (isActive()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [customerId, projectId],
  );

  const reload = useCallback(() => load(ALWAYS_ACTIVE), [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load(() => !cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Live updates (T-385): subscribe to ssh-connection events on the WS bus.
  // Customer-scoped events come in with projectId=null (broadcast), so we
  // filter client-side by matching customerId on the payload. Project-scoped
  // subscriptions use the existing `project` scope filter on the bus.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    if (!customerId && !projectId) return;
    const scopeArg = projectId
      ? ({ kind: 'project', projectId } as const)
      : ({ kind: 'global' } as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debouncedReload = () => {
      if (timer) clearTimeout(timer);
      // 250ms coalescing keeps an update-burst (e.g. status + auth row in
      // quick succession) from triggering N back-to-back fetches.
      timer = setTimeout(() => {
        void reloadRef.current();
      }, 250);
    };
    const unsub = wsEventBus.subscribe(scopeArg, (event) => {
      if (!isProjectChangeEvent(event)) return;
      if (event.entity !== 'ssh-connection') return;
      // Scope match. Customer-scope tabs stay strict (filter on customerId).
      // Project-scope tabs are pragmatically lenient (T-386): any
      // ssh-connection event triggers reload. Reason: the project may
      // inherit connections from linked customers, and a fine-grained
      // membership check would require pulling the customer-project-link
      // table into the browser. A single extra debounced fetch is cheaper.
      if (customerId) {
        if (event.customerId && event.customerId !== customerId) return;
        if (!event.customerId) return; // foreign project event
      }
      // For projectId scope: no client-side filter — debounced reload
      // covers both own-project events and customer-side mutations that
      // would change what the project sees as "inherited".
      debouncedReload();
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [customerId, projectId]);

  return { data, loading, error, reload };
}
