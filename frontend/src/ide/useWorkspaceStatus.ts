import { useEffect, useRef, useState } from 'react';
import { ideApi } from './ide-api';
import { useIdeStore } from './ide-store';

/** Minimum gap between two status requests. */
const MIN_INTERVAL_MS = 5000;

/** Lookup for "does this tree path carry a change marker?". */
export interface ChangedMarks {
  has: (path: string) => boolean;
}

const NO_MARKS: ChangedMarks = { has: () => false };

function buildMarks(paths: string[]): ChangedMarks {
  const exact = new Set<string>();
  const untrackedDirs = new Set<string>();
  const ancestors = new Set<string>();
  for (const raw of paths) {
    const isDir = raw.endsWith('/');
    const path = isDir ? raw.slice(0, -1) : raw;
    exact.add(path);
    if (isDir) untrackedDirs.add(path);
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) ancestors.add(path.slice(0, i));
  }
  return {
    has: (path) => {
      if (exact.has(path) || ancestors.has(path)) return true;
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        if (untrackedDirs.has(path.slice(0, i))) return true;
      }
      return false;
    },
  };
}

/**
 * Git branch and changed-file markers of a workspace. Fetched on load and after each
 * successful save, at most once per 5 s (a save inside the window schedules one trailing
 * request). Never while the workspace is blocked; no interval timer.
 */
export function useWorkspaceStatus(workspaceId: string): { branch: string | null; marks: ChangedMarks } {
  const [state, setState] = useState<{ branch: string | null; marks: ChangedMarks }>({ branch: null, marks: NO_MARKS });
  const saveTick = useIdeStore((s) => s.saveTick);
  const lastFetch = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  // A response that lands after the workspace changed must not overwrite the new state.
  const currentWorkspace = useRef(workspaceId);

  useEffect(() => {
    currentWorkspace.current = workspaceId;
    const run = (): void => {
      timer.current = null;
      if (useIdeStore.getState().blocked !== null || inFlight.current) return;
      inFlight.current = true;
      lastFetch.current = Date.now();
      ideApi.status(workspaceId).then(
        (status) => {
          inFlight.current = false;
          if (currentWorkspace.current === workspaceId) setState({ branch: status.branch, marks: buildMarks(status.changed.map((c) => c.path)) });
        },
        (error: unknown) => {
          inFlight.current = false;
          if (currentWorkspace.current === workspaceId) useIdeStore.getState().noteApiError(error);
        },
      );
    };
    const wait = lastFetch.current + MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) run();
    else if (timer.current === null) timer.current = window.setTimeout(run, wait);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [workspaceId, saveTick]);

  return state;
}
