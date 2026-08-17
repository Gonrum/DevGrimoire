import { useCallback, useEffect, useState } from 'react';
import { api, SshConnectionDetail } from '../../../api/client';

interface UseSshConnectionResult {
  data: SshConnectionDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** `isActive` for callers that always want the result applied — see `load`. */
const ALWAYS_ACTIVE = () => true;

/**
 * Loads a single SSH connection detail (includes credential refs and the
 * accepted host-key fingerprint). Returns `null` until first load resolves.
 */
export function useSshConnection(id: string | null | undefined): UseSshConnectionResult {
  const [data, setData] = useState<SshConnectionDetail | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<string | null>(null);

  /**
   * `isActive` gates the state write: `id` changes when the form switches
   * from create- into edit-mode on a freshly created connection, so a
   * pending fetch for the previous id must not land in the new one's state.
   */
  const load = useCallback(
    async (isActive: () => boolean) => {
      if (!id) {
        setData(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const detail = await api.ssh.get(id);
        if (isActive()) setData(detail);
      } catch (err) {
        if (isActive()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [id],
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

  return { data, loading, error, reload };
}
