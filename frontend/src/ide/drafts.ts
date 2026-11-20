import { del, get, set } from 'idb-keyval';
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

export async function clearDraft(workspaceId: string, path: string): Promise<void> {
  try {
    await del(key(workspaceId, path));
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
