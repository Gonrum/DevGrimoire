import { useCallback, useEffect, useState } from 'react';
import { api, SshAuditQueryParams, SshAuditResponse } from '../../../api/client';

interface UseSshAuditResult {
  data: SshAuditResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads paginated audit entries for a single SSH connection. When
 * `connectionId === null` the hook stays idle and returns `data: null`
 * (no fetch is issued) — used so the parent can mount the audit modal
 * conditionally without a separate effect.
 *
 * Implementation mirrors `useSshConnections`: plain-state pattern, no
 * react-query (the repo doesn't use it). The caller invalidates by
 * calling `reload()`; live updates are out of scope for T-384 (the audit
 * collection itself isn't on the WS-multiplex bus).
 */
export function useSshAudit(
  connectionId: string | null,
  opts: SshAuditQueryParams = {},
): UseSshAuditResult {
  const { limit, offset, sourceContext } = opts;
  const [data, setData] = useState<SshAuditResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(!!connectionId);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
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
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, limit, offset, sourceContext]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
