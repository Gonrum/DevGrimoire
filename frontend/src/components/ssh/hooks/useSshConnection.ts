import { useCallback, useEffect, useState } from 'react';
import { api, SshConnectionDetail } from '../../../api/client';

interface UseSshConnectionResult {
  data: SshConnectionDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads a single SSH connection detail (includes credential refs and the
 * accepted host-key fingerprint). Returns `null` until first load resolves.
 */
export function useSshConnection(id: string | null | undefined): UseSshConnectionResult {
  const [data, setData] = useState<SshConnectionDetail | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const detail = await api.ssh.get(id);
      setData(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
