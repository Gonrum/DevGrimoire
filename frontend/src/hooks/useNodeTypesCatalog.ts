import { useEffect, useMemo, useState } from 'react';
import { workflowsApi, WorkflowNodeMetadata } from '../api/workflows';

interface CachedCatalog {
  data: WorkflowNodeMetadata[];
  fetchedAt: number;
}

const REVALIDATE_AFTER_MS = 60_000;
let cache: CachedCatalog | null = null;
let inflight: Promise<WorkflowNodeMetadata[]> | null = null;

export interface NodeTypesCatalog {
  catalog: WorkflowNodeMetadata[];
  byType: Record<string, WorkflowNodeMetadata>;
  byCategory: Record<string, WorkflowNodeMetadata[]>;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchCatalog(): Promise<WorkflowNodeMetadata[]> {
  if (inflight) return inflight;
  inflight = workflowsApi
    .listNodeTypes()
    .then((data) => {
      cache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useNodeTypesCatalog(): NodeTypesCatalog {
  const [catalog, setCatalog] = useState<WorkflowNodeMetadata[]>(cache?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setError(null);
    setIsLoading(!cache);
    try {
      const data = await fetchCatalog();
      setCatalog(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!cache || Date.now() - cache.fetchedAt > REVALIDATE_AFTER_MS) {
      void load();
    } else {
      setCatalog(cache.data);
      setIsLoading(false);
    }
  }, []);

  const { byType, byCategory } = useMemo(() => {
    const bt: Record<string, WorkflowNodeMetadata> = {};
    const bc: Record<string, WorkflowNodeMetadata[]> = {};
    for (const m of catalog) {
      bt[m.type] = m;
      (bc[m.category] ||= []).push(m);
    }
    return { byType: bt, byCategory: bc };
  }, [catalog]);

  return { catalog, byType, byCategory, isLoading, error, refresh: load };
}
