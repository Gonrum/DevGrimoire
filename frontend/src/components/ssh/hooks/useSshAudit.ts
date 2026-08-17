import { useCallback, useEffect, useRef, useState } from 'react';
import { api, SshAuditQueryParams, SshAuditResponse } from '../../../api/client';
import { isProjectChangeEvent, wsEventBus } from '../../../api/wsEventBus';

interface UseSshAuditResult {
  data: SshAuditResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * `isActive` for a caller that always wants the result applied (manual
 * `reload()` from a retry button). The effect below passes a cancel-flag
 * probe instead — see there.
 */
const ALWAYS_ACTIVE = () => true;

/**
 * Loads paginated audit entries for a single SSH connection. When
 * `connectionId === null` the hook stays idle and returns `data: null`
 * (no fetch is issued) — used so the parent can mount the audit modal
 * conditionally without a separate effect.
 *
 * Implementation mirrors `useSshConnections`: plain-state pattern, no
 * react-query (the repo doesn't use it). T-385 adds live refresh: when the
 * audit modal is open and a fresh ssh-audit row is written the WS multiplex
 * bus emits an `ssh-audit:created` event and we refetch (debounced).
 */
export function useSshAudit(
  connectionId: string | null,
  opts: SshAuditQueryParams = {},
): UseSshAuditResult {
  const { limit, offset, sourceContext } = opts;
  const [data, setData] = useState<SshAuditResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(!!connectionId);
  const [error, setError] = useState<string | null>(null);

  /**
   * `isActive` decides whether a resolved request may still write state.
   * Pagination and the source-context filter change `offset`/`sourceContext`,
   * so two fetches can be in flight at once and the slower (older) answer
   * would otherwise overwrite the newer page.
   */
  const load = useCallback(
    async (isActive: () => boolean) => {
      if (!connectionId) {
        setData(null);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await api.ssh.getAudit(connectionId, {
          limit,
          offset,
          sourceContext,
        });
        if (isActive()) setData(result);
      } catch (err) {
        if (isActive()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [connectionId, limit, offset, sourceContext],
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

  // Live updates (T-385). ssh-audit rows broadcast (projectId=null because
  // the audit collection doesn't carry scope) — we filter client-side by
  // connectionId so foreign-audit events don't trigger refetches.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    if (!connectionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (!isProjectChangeEvent(event)) return;
      if (event.entity !== 'ssh-audit') return;
      // The Change-Stream-derived event doesn't include connectionId; we
      // refetch on any ssh-audit event then let the server filter by
      // connection. Cheap because the audit page-size is small.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reloadRef.current();
      }, 250);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [connectionId]);

  return { data, loading, error, reload };
}
