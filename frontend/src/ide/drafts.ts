import { del, get, keys, set } from 'idb-keyval';
import { isRecord } from '../lib/narrow';

/** Unsaved buffers survive reloads, closed tabs and browser crashes (IndexedDB). */
export interface Draft {
  content: string;
  /** Hash of the on-disk version the draft is based on; null = file did not exist yet. */
  baseHash: string | null;
  savedAt: number;
}

function key(workspaceId: string, path: string): string {
  return `draft:${workspaceId}:${path}`;
}

function isDraft(value: unknown): value is Draft {
  return (
    isRecord(value) &&
    typeof value.content === 'string' &&
    (typeof value.baseHash === 'string' || value.baseHash === null) &&
    typeof value.savedAt === 'number'
  );
}

/*
 * IndexedDB can be unavailable (private mode, blocked site data). Drafts are a
 * safety net, never a precondition: every failure degrades to "no draft".
 */

export async function saveDraft(workspaceId: string, path: string, draft: Draft): Promise<void> {
  try {
    await set(key(workspaceId, path), draft);
  } catch {
    /* storage unavailable — the buffer just won't survive a reload */
  }
}

export async function loadDraft(workspaceId: string, path: string): Promise<Draft | undefined> {
  try {
    const value: unknown = await get(key(workspaceId, path));
    return isDraft(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Paths (at or under `prefix`) that have a draft in this workspace. */
async function draftPathsUnder(workspaceId: string, prefix: string): Promise<string[]> {
  const head = `draft:${workspaceId}:`;
  const all = await keys();
  const paths: string[] = [];
  for (const k of all) {
    if (typeof k !== 'string' || !k.startsWith(head)) continue;
    const path = k.slice(head.length);
    // Exact path or a real child: `src/a` must not match `src/ab`.
    if (path === prefix || path.startsWith(`${prefix}/`)) paths.push(path);
  }
  return paths;
}

/**
 * Re-keys every draft at or under `fromPrefix` to `toPrefix` (rename/move in the tree), also
 * for files without an open tab. A draft already at the target is never overwritten: the
 * target keeps its own draft and the source draft stays where it is.
 */
export async function moveDraftsUnder(workspaceId: string, fromPrefix: string, toPrefix: string): Promise<void> {
  try {
    for (const path of await draftPathsUnder(workspaceId, fromPrefix)) {
      const target = toPrefix + path.slice(fromPrefix.length);
      const draft = await loadDraft(workspaceId, path);
      if (!draft || (await get(key(workspaceId, target))) !== undefined) continue;
      await set(key(workspaceId, target), draft);
      await del(key(workspaceId, path));
    }
  } catch {
    /* storage unavailable — the rename itself is unaffected */
  }
}

/** Drops every draft at or under `prefix` (the file/folder was deleted on purpose). */
export async function clearDraftsUnder(workspaceId: string, prefix: string): Promise<void> {
  try {
    for (const path of await draftPathsUnder(workspaceId, prefix)) await del(key(workspaceId, path));
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export async function clearDraft(workspaceId: string, path: string): Promise<void> {
  try {
    await del(key(workspaceId, path));
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
