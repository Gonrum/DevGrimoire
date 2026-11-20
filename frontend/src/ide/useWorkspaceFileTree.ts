import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/narrow';
import { ideApi, IdeApiError, type IdeTreeEntry } from './ide-api';
import { useIdeStore } from './ide-store';

export interface TreeListing {
  entries: IdeTreeEntry[];
  truncated: boolean;
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Copy of `record` with every key at or under `prefix` dropped. */
function withoutKeysUnder<T>(record: Record<string, T>, prefix: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !isUnder(key, prefix)));
}

/**
 * Lazy directory loading with expand state. No watcher: callers reload explicitly —
 * `reloadDirs()` after a mutation (only the touched parents), `refresh()` for everything.
 * State is not reset when `workspaceId` changes — mount the consumer with `key={workspaceId}`.
 * `initialRoot`: a root listing the caller already has; the hook then skips its own first load.
 */
export function useWorkspaceFileTree(workspaceId: string | null, initialRoot?: TreeListing) {
  const [byDir, setByDir] = useState<Record<string, IdeTreeEntry[]>>(() => {
    const seed: Record<string, IdeTreeEntry[]> = {};
    if (initialRoot) seed['.'] = initialRoot.entries;
    return seed;
  });
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(() =>
    initialRoot?.truncated ? new Set(['.']) : new Set(),
  );
  const [seeded] = useState(() => initialRoot !== undefined);
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
        // A subdirectory that vanished (deleted/moved elsewhere) is dropped, not an error,
        // and no longer counts as expanded (otherwise every refresh asks for it again).
        if (path !== '.' && status === 404) {
          setByDir((prev) => withoutKeysUnder(prev, path));
          setExpanded((prev) => {
            if (![...prev].some((p) => isUnder(p, path))) return prev;
            return new Set([...prev].filter((p) => !isUnder(p, path)));
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

  /**
   * Reloads only the given directories (the parents a mutation touched), and only
   * those currently shown: the root or an expanded folder.
   */
  const reloadDirs = useCallback(
    async (dirs: string[]): Promise<void> => {
      const shown = [...new Set(dirs)].filter((dir) => dir === '.' || expanded.has(dir));
      await Promise.all(shown.map((dir) => loadDir(dir).catch(() => undefined)));
    },
    [expanded, loadDir],
  );

  /** Forgets everything at or under a deleted path (listing, expand state, errors). */
  const forgetPath = useCallback((path: string): void => {
    setByDir((prev) => withoutKeysUnder(prev, path));
    setErrors((prev) => withoutKeysUnder(prev, path));
    setTruncatedDirs((prev) => new Set([...prev].filter((p) => !isUnder(p, path))));
    setExpanded((prev) => new Set([...prev].filter((p) => !isUnder(p, path))));
  }, []);

  /** Re-maps everything at or under a renamed/moved path to its new prefix. */
  const renamePath = useCallback((from: string, to: string): void => {
    const remap = (p: string): string => (isUnder(p, from) ? to + p.slice(from.length) : p);
    setByDir((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([dir, list]) => [
          remap(dir),
          list.map((e) => (isUnder(e.path, from) ? { ...e, path: remap(e.path), name: baseName(remap(e.path)) } : e)),
        ]),
      ),
    );
    setErrors((prev) => Object.fromEntries(Object.entries(prev).map(([dir, msg]) => [remap(dir), msg])));
    setTruncatedDirs((prev) => new Set([...prev].map(remap)));
    setExpanded((prev) => new Set([...prev].map(remap)));
  }, []);

  useEffect(() => {
    currentWorkspace.current = workspaceId;
    // The caller handed over the root listing for this mount: no second identical request.
    if (seeded) return;
    // Deferred so the load's state updates never run synchronously inside the effect body.
    void Promise.resolve()
      .then(() => loadDir('.'))
      .catch(() => undefined);
  }, [workspaceId, loadDir, seeded]);

  return {
    byDir,
    truncatedDirs,
    expanded,
    rootError,
    errors,
    toggleDir,
    expandDir,
    loadDir,
    refresh,
    reloadDirs,
    forgetPath,
    renamePath,
  };
}
