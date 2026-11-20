import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/narrow';
import { ideApi, IdeApiError, type IdeTreeEntry } from './ide-api';
import { useIdeStore } from './ide-store';

/**
 * Lazy directory loading with expand state. No watcher: callers `refresh()` explicitly.
 * State is not reset when `workspaceId` changes — mount the consumer with `key={workspaceId}`.
 */
export function useWorkspaceFileTree(workspaceId: string | null) {
  const [byDir, setByDir] = useState<Record<string, IdeTreeEntry[]>>({});
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']));
  const [rootError, setRootError] = useState<Error | null>(null);
  /** Per-directory load failures, shown inline under the folder; cleared on a successful load. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Guards against responses of a previous workspace landing in the current state.
  const currentWorkspace = useRef(workspaceId);

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      if (!workspaceId) return;
      try {
        const { entries, truncated } = await ideApi.tree(workspaceId, path);
        if (currentWorkspace.current !== workspaceId) return;
        setByDir((prev) => ({ ...prev, [path]: entries }));
        setTruncatedDirs((prev) => {
          if (prev.has(path) === truncated) return prev;
          const next = new Set(prev);
          if (truncated) next.add(path);
          else next.delete(path);
          return next;
        });
        setErrors((prev) => {
          if (!(path in prev)) return prev;
          const rest = { ...prev };
          delete rest[path];
          return rest;
        });
        if (path === '.') setRootError(null);
      } catch (error) {
        if (currentWorkspace.current !== workspaceId) return;
        const status = error instanceof IdeApiError ? error.status : 0;
        // These states belong to the whole IDE, not to one folder.
        if (status === 403) useIdeStore.getState().setBlocked('forbidden');
        else if (status === 409) useIdeStore.getState().setBlocked('archived');
        else if (status === 404 && path === '.') useIdeStore.getState().setBlocked('gone');
        // A subdirectory that vanished (deleted/moved elsewhere) is dropped, not an error.
        if (path !== '.' && status === 404) {
          setByDir((prev) => {
            const rest = { ...prev };
            delete rest[path];
            return rest;
          });
          return;
        }
        setErrors((prev) => ({ ...prev, [path]: errorMessage(error) }));
        if (path === '.') setRootError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [workspaceId],
  );

  const expandDir = useCallback(
    (path: string): void => {
      setExpanded((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      loadDir(path).catch(() => undefined);
    },
    [loadDir],
  );

  const toggleDir = useCallback(
    (path: string): void => {
      const open = expanded.has(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!open) loadDir(path).catch(() => undefined);
    },
    [expanded, loadDir],
  );

  /** Reloads every expanded directory; failures of single directories are ignored. */
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([...expanded].map((dir) => loadDir(dir).catch(() => undefined)));
  }, [expanded, loadDir]);

  useEffect(() => {
    currentWorkspace.current = workspaceId;
    // Deferred so the load's state updates never run synchronously inside the effect body.
    void Promise.resolve()
      .then(() => loadDir('.'))
      .catch(() => undefined);
  }, [workspaceId, loadDir]);

  return { byDir, truncatedDirs, expanded, rootError, errors, toggleDir, expandDir, loadDir, refresh };
}
