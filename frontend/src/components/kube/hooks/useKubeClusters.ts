import { useCallback, useEffect, useState } from 'react';
import { api, KubeCluster } from '../../../api/client';

export interface UseKubeClustersScope {
  projectId?: string;
  customerId?: string;
}

interface UseKubeClustersResult {
  clusters: KubeCluster[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Plain-State-Muster wie `useSshConnections.ts` — das Repo benutzt kein
 * react-query.
 */
export function useKubeClusters(scope: UseKubeClustersScope): UseKubeClustersResult {
  const { projectId, customerId } = scope;
  const [clusters, setClusters] = useState<KubeCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setClusters(await api.listKubeClusters({ projectId, customerId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }, [projectId, customerId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  return { clusters, loading, error, reload: load };
}
