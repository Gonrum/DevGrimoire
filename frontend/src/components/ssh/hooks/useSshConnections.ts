import { useCallback, useEffect, useState } from 'react';
import { api, SshConnectionListItem } from '../../../api/client';

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

/**
 * Lists SSH connections for the given scope. Exactly one of `customerId` or
 * `projectId` must be set (mirrors backend `/api/customers/:id/ssh-connections`
 * and `/api/projects/:id/ssh-connections`).
 *
 * Implementation note: the rest of the codebase doesn't use react-query, so
 * this hook follows the same plain-state pattern as `MonitoringTab`. Live
 * updates over the WS multiplex bus come in T-385; for now callers invalidate
 * by calling `reload()` after a mutation.
 */
export function useSshConnections(scope: UseSshConnectionsScope): UseSshConnectionsResult {
  const { customerId, projectId } = scope;
  const [data, setData] = useState<SshConnectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
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
      setData(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [customerId, projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
