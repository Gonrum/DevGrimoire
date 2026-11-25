import { create } from 'zustand';
import { isRecord } from '../lib/narrow';
import { clearDraft, clearDraftsUnder, loadDraft, moveDraftsUnder, saveDraft } from './drafts';
import { addCodeRef, type AddCodeRefResult, type ChatCodeRef } from './code-refs';
import { ideApi, IdeApiError, IdeConflictError, type IdeFile } from './ide-api';

/** POSIX single-quote escaping — workspace shells are always sh-like. */
function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

export interface OpenTab {
  path: string;
  content: string;
  /** Hash of the on-disk version this buffer is based on; null for a file not yet on disk. */
  baseHash: string | null;
  dirty: boolean;
  /** Set when the file changed on disk while this tab had unsaved edits. */
  conflict: boolean;
  kind: 'text' | 'binary' | 'too-large' | 'image';
  size: number;
  /** `data:` URL of an image tab (the CSP forbids `blob:` images). */
  previewUrl?: string;
  /** Editor limit in bytes that made a `too-large` tab (when the backend said so). */
  limit?: number;
}

export interface RevealTarget {
  path: string;
  line: number;
  column: number;
}

export type SidePanel = 'files' | 'search';

/** A request to the file tree to reload directories (`all`: every expanded one). */
export interface TreeRefresh {
  seq: number;
  dirs: string[];
  all: boolean;
}
export type BlockedReason = null | 'archived' | 'gone' | 'forbidden';

interface IdeState {
  workspaceId: string | null;
  /** Absolute workspace directory as the sidecar sees it (`Workspace.path`), once loaded. */
  workspaceRoot: string | null;
  tabs: OpenTab[];
  activePath: string | null;
  /** Second editor group: file shown to the right of the active editor. */
  splitPath: string | null;
  panel: SidePanel;
  sidebarWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
  /** Right-hand agent sidebar: shown or collapsed, and its width (both persisted). */
  agentOpen: boolean;
  agentWidth: number;
  /** Code attached to the next agent message (not persisted, cleared on workspace change). */
  codeRefs: ChatCodeRef[];
  /** Bumped on each attach so the agent input can take focus. */
  codeRefFocusTick: number;
  /** Terminal tabs: each id is one live PTY session component. */
  terminals: number[];
  activeTerminal: number | null;
  /** One-shot command typed into the terminal on next open (e.g. cd from the file tree). */
  terminalInputs: Record<number, string>;
  /** One-shot cursor target the editor applies once the file is shown. */
  reveal: RevealTarget | null;
  blocked: BlockedReason;
  /** Bumped after every successful write or tree change; the git status fetch listens to it. */
  saveTick: number;
  /** Bumped when something outside the tree (the IDE agent) changed files; the tree reloads. */
  treeRefresh: TreeRefresh;

  /** Switches the IDE to a workspace; a call for the current one only updates `rootPath`. */
  setWorkspace: (workspaceId: string, rootPath?: string) => void;
  openFile: (path: string, sizeHint?: number) => Promise<void>;
  openFileAt: (path: string, line: number, column?: number) => Promise<void>;
  /** Returns the pending reveal for this path (and clears it), or null. */
  consumeReveal: (path: string) => RevealTarget | null;
  closeTab: (path: string) => void;
  /** Close a tab and drop its draft — the user chose to throw the unsaved edits away. */
  discardTab: (path: string) => Promise<void>;
  /** Close every tab at or under a path — used after delete in the tree. */
  closeTabsUnder: (pathPrefix: string) => void;
  /** Re-point tabs at or under `from` to `to` — used after rename/move in the tree. */
  renameTabsUnder: (from: string, to: string) => void;
  setActive: (path: string) => void;
  edit: (path: string, content: string) => void;
  save: (path: string) => Promise<{ conflict: boolean }>;
  /** Conflict resolution "keep mine": overwrite disk regardless of the stale baseHash. */
  forceSave: (path: string) => Promise<void>;
  reloadFromDisk: (path: string) => Promise<void>;
  /** Current disk version of a file, or null if it no longer exists. */
  readDisk: (path: string) => Promise<IdeFile | null>;
  /**
   * Compares an open text tab with the disk (window regained focus): a clean tab
   * silently takes the new version, an edited one is flagged as conflict.
   */
  recheckFromDisk: (path: string) => Promise<void>;
  /** Maps 403 / 409 (not active) / 404 (workspace gone) of any IDE call to `blocked`. */
  noteApiError: (error: unknown) => void;
  openInSplit: (path: string) => Promise<void>;
  closeSplit: () => void;
  setPanel: (panel: SidePanel) => void;
  setSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  setTerminalOpen: (open: boolean) => void;
  setAgentOpen: (open: boolean) => void;
  attachCodeRef: (ref: ChatCodeRef) => AddCodeRefResult;
  removeCodeRef: (index: number) => void;
  clearCodeRefs: () => void;
  /** Drops exactly the given (already sent) refs by identity; refs attached since stay. */
  removeSentCodeRefs: (sent: readonly ChatCodeRef[]) => void;
  setAgentWidth: (width: number) => void;
  addTerminal: (initialInput?: string) => void;
  closeTerminal: (id: number) => void;
  setActiveTerminal: (id: number) => void;
  /** Drops a tab's pending initial input once it has been typed into the shell. */
  clearTerminalInput: (id: number) => void;
  openTerminalAt: (dir: string) => void;
  setBlocked: (blocked: BlockedReason) => void;
  /**
   * The IDE agent changed these paths (`'.'` = anything, after a command): reload the
   * parent folders in the tree, the git status and every open tab at or under a path
   * that has no unsaved changes. Tabs with unsaved changes are left alone.
   */
  applyWorkspaceChanged: (paths: string[]) => void;
}

const LAYOUT_KEY = 'dg.ide.layout';
const SIDEBAR_RANGE = [180, 560] as const;
const TERMINAL_RANGE = [120, 800] as const;
export const AGENT_RANGE = [280, 900] as const;

let nextTerminalId = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface Layout {
  sidebarWidth: number;
  terminalHeight: number;
  agentOpen: boolean;
  agentWidth: number;
}

const DEFAULT_LAYOUT: Layout = { sidebarWidth: 260, terminalHeight: 256, agentOpen: false, agentWidth: 380 };

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const source = isRecord(parsed) ? parsed : {};
    return {
      sidebarWidth: clamp(numberOr(source.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth), ...SIDEBAR_RANGE),
      terminalHeight: clamp(numberOr(source.terminalHeight, DEFAULT_LAYOUT.terminalHeight), ...TERMINAL_RANGE),
      agentOpen: source.agentOpen === true,
      agentWidth: clamp(numberOr(source.agentWidth, DEFAULT_LAYOUT.agentWidth), ...AGENT_RANGE),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function persistLayout(layout: Layout): void {
  try {
    const { sidebarWidth, terminalHeight, agentOpen, agentWidth } = layout;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth, terminalHeight, agentOpen, agentWidth }));
  } catch {
    /* storage full/blocked — layout just won't persist */
  }
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Workspace-relative form of a reported path: no `./` in front, no `/` at the end. */
function normalizeChangedPath(path: string): string {
  const trimmed = path.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '.' : path.slice(0, i);
}

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
]);

function imageMime(path: string): string | undefined {
  return IMAGE_MIME.get(path.split('.').pop()?.toLowerCase() ?? '');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('FileReader returned no data URL'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function placeholderTab(path: string, kind: OpenTab['kind'], size: number): OpenTab {
  return { path, content: '', baseHash: null, dirty: false, conflict: false, kind, size };
}

/** 415 tab: an image preview for small images, otherwise a binary card. */
async function nonTextTab(workspaceId: string, path: string, sizeHint: number): Promise<OpenTab> {
  const mime = imageMime(path);
  if (!mime || sizeHint > IMAGE_MAX_BYTES) return placeholderTab(path, 'binary', sizeHint);
  const blob = await ideApi.previewBlob(workspaceId, path, IMAGE_MAX_BYTES);
  // Larger than the preview cap (or no size announced): binary card, nothing loaded.
  if (!blob) return placeholderTab(path, 'binary', sizeHint);
  // The size hint can be missing (0) or stale; the downloaded size is authoritative.
  if (blob.size > IMAGE_MAX_BYTES) return placeholderTab(path, 'binary', blob.size);
  const previewUrl = await blobToDataUrl(new Blob([blob], { type: mime }));
  return { ...placeholderTab(path, 'image', blob.size), previewUrl };
}

/**
 * Text tab from the disk version plus a stored draft, if any. A draft is never
 * dropped unless the disk already holds exactly its content: with a matching hash
 * it becomes the unsaved buffer, with a different hash it is shown as a conflict.
 */
async function textTab(workspaceId: string, path: string, file: IdeFile): Promise<OpenTab> {
  const clean: OpenTab = {
    path,
    content: file.content,
    baseHash: file.hash,
    dirty: false,
    conflict: false,
    kind: 'text',
    size: file.size,
  };
  const draft = await loadDraft(workspaceId, path);
  if (!draft) return clean;
  if (draft.content === file.content) {
    void clearDraft(workspaceId, path);
    return clean;
  }
  if (draft.baseHash === file.hash) return { ...clean, content: draft.content, dirty: true };
  // The disk moved on since the draft was taken: keep the draft, let the user decide.
  return { ...clean, content: draft.content, baseHash: draft.baseHash, dirty: true, conflict: true };
}

/** Reads a file into a tab; 415/413 become placeholder tabs instead of errors. */
async function readTab(workspaceId: string, path: string, sizeHint: number): Promise<OpenTab> {
  let file: IdeFile;
  try {
    file = await ideApi.readFile(workspaceId, path);
  } catch (error) {
    if (error instanceof IdeApiError && error.status === 415) return nonTextTab(workspaceId, path, sizeHint);
    if (error instanceof IdeApiError && error.status === 413) {
      return { ...placeholderTab(path, 'too-large', sizeHint), limit: error.limit };
    }
    throw error;
  }
  return textTab(workspaceId, path, file);
}

/**
 * Saves of one file run one after another. A second save started while the first is
 * in flight would otherwise send the old baseHash and conflict with our own write.
 */
const inflight = new Map<string, Promise<unknown>>();

function inflightKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`;
}

async function serialized<T>(workspaceId: string, path: string, run: () => Promise<T>): Promise<T> {
  const k = inflightKey(workspaceId, path);
  const previous = inflight.get(k) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  inflight.set(k, next);
  try {
    return await next;
  } finally {
    if (inflight.get(k) === next) inflight.delete(k);
  }
}

type StoreSet = (partial: Partial<IdeState>) => void;

/**
 * Records a finished write. The tab may have been edited, closed, or the workspace
 * switched while the request was in flight: it only turns clean if its content is
 * still exactly what was written; otherwise it stays dirty on top of the new hash,
 * and its draft is re-based on that hash so a reload does not report a false conflict.
 */
function applyWritten(
  set: StoreSet,
  get: () => IdeState,
  workspaceId: string,
  path: string,
  written: string,
  hash: string,
): void {
  if (get().workspaceId !== workspaceId) return;
  set({
    tabs: get().tabs.map((t) =>
      t.path === path ? { ...t, baseHash: hash, dirty: t.content !== written, conflict: false } : t,
    ),
    saveTick: get().saveTick + 1,
  });
  const tab = get().tabs.find((t) => t.path === path);
  if (!tab) return;
  if (tab.dirty) void saveDraft(workspaceId, path, { content: tab.content, baseHash: hash, savedAt: Date.now() });
  else void clearDraft(workspaceId, path);
}

export const useIdeStore = create<IdeState>((set, get) => ({
  workspaceId: null,
  workspaceRoot: null,
  tabs: [],
  activePath: null,
  splitPath: null,
  panel: 'files',
  terminalOpen: false,
  terminals: [],
  activeTerminal: null,
  terminalInputs: {},
  reveal: null,
  blocked: null,
  codeRefs: [],
  codeRefFocusTick: 0,
  saveTick: 0,
  treeRefresh: { seq: 0, dirs: [], all: false },
  ...loadLayout(),

  setWorkspace: (workspaceId, rootPath) => {
    if (get().workspaceId !== workspaceId) {
      set({
        workspaceId,
        workspaceRoot: rootPath ?? null,
        tabs: [],
        activePath: null,
        splitPath: null,
        reveal: null,
        blocked: null,
        // Terminal tabs belong to one workspace; `terminalOpen` keeps the user's choice.
        terminals: [],
        activeTerminal: null,
        terminalInputs: {},
        codeRefs: [],
      });
    } else if (rootPath !== undefined && get().workspaceRoot !== rootPath) {
      set({ workspaceRoot: rootPath });
    }
  },

  openFile: async (path, sizeHint = 0) => {
    const { workspaceId, tabs } = get();
    if (!workspaceId) return;
    if (tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }
    let tab: OpenTab;
    try {
      tab = await readTab(workspaceId, path, sizeHint);
    } catch (error) {
      if (get().workspaceId === workspaceId) get().noteApiError(error);
      throw error;
    }
    // The workspace may have changed or the tab been opened meanwhile.
    if (get().workspaceId !== workspaceId) return;
    if (get().tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }
    set({ tabs: [...get().tabs, tab], activePath: path });
  },

  openFileAt: async (path, line, column = 1) => {
    set({ reveal: { path, line, column } });
    await get().openFile(path);
  },

  consumeReveal: (path) => {
    const reveal = get().reveal;
    if (!reveal || reveal.path !== path) return null;
    set({ reveal: null });
    return reveal;
  },

  closeTab: (path) => {
    const tabs = get().tabs.filter((t) => t.path !== path);
    const activePath = get().activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : get().activePath;
    const splitPath = get().splitPath === path ? null : get().splitPath;
    set({ tabs, activePath, splitPath });
  },

  discardTab: async (path) => {
    const { workspaceId } = get();
    get().closeTab(path);
    if (workspaceId) await clearDraft(workspaceId, path);
  },

  closeTabsUnder: (pathPrefix) => {
    const tabs = get().tabs.filter((t) => !isUnder(t.path, pathPrefix));
    const active = get().activePath;
    const activePath = tabs.some((t) => t.path === active) ? active : (tabs[tabs.length - 1]?.path ?? null);
    const splitPath = tabs.some((t) => t.path === get().splitPath) ? get().splitPath : null;
    set({ tabs, activePath, splitPath });
    // The entry was deleted on purpose: drop its drafts too, also those without an open tab.
    // Issued after the tabs are gone, so no later draft write for these paths can follow, and
    // IndexedDB runs it after any draft write issued before.
    const { workspaceId } = get();
    if (workspaceId) void clearDraftsUnder(workspaceId, pathPrefix);
  },

  renameTabsUnder: (from, to) => {
    const rename = (path: string): string => (isUnder(path, from) ? to + path.slice(from.length) : path);
    const { activePath, splitPath, workspaceId } = get();
    set({
      tabs: get().tabs.map((t) => (isUnder(t.path, from) ? { ...t, path: rename(t.path) } : t)),
      activePath: activePath === null ? null : rename(activePath),
      splitPath: splitPath === null ? null : rename(splitPath),
    });
    // Drafts are keyed by path: move all of them, also those of closed tabs ("close, keep draft").
    // An open dirty tab's draft already holds its buffer, since every edit writes it.
    if (workspaceId) void moveDraftsUnder(workspaceId, from, to);
  },

  setActive: (path) => set({ activePath: path }),

  edit: (path, content) => {
    const { workspaceId } = get();
    set({
      tabs: get().tabs.map((t) =>
        t.path === path && t.kind === 'text' ? { ...t, content, dirty: content !== t.content || t.dirty } : t,
      ),
    });
    const tab = get().tabs.find((t) => t.path === path);
    if (workspaceId && tab?.kind === 'text' && tab.dirty) {
      void saveDraft(workspaceId, path, { content: tab.content, baseHash: tab.baseHash, savedAt: Date.now() });
    }
  },

  save: async (path) => {
    const { workspaceId } = get();
    if (!workspaceId) return { conflict: false };
    return serialized(workspaceId, path, async () => {
      // Re-read after waiting: an earlier save may have moved baseHash on.
      const { blocked, tabs } = get();
      if (get().workspaceId !== workspaceId || blocked !== null) return { conflict: false };
      const tab = tabs.find((t) => t.path === path);
      if (!tab || tab.kind !== 'text' || !tab.dirty) return { conflict: false };
      // A conflicted tab is only written through the explicit "keep mine" (forceSave).
      if (tab.conflict) return { conflict: true };
      const written = tab.content;
      try {
        const result = await ideApi.writeFile(workspaceId, path, written, { baseHash: tab.baseHash });
        applyWritten(set, get, workspaceId, path, written, result.hash);
        return { conflict: false };
      } catch (error) {
        const current = get().workspaceId === workspaceId;
        if (error instanceof IdeConflictError) {
          if (current) set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, conflict: true } : t)) });
          return { conflict: true };
        }
        if (current) get().noteApiError(error);
        throw error;
      }
    });
  },

  forceSave: async (path) => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    await serialized(workspaceId, path, async () => {
      const tab = get().tabs.find((t) => t.path === path);
      if (get().workspaceId !== workspaceId || get().blocked !== null || !tab || tab.kind !== 'text') return;
      const written = tab.content;
      try {
        const result = await ideApi.writeFile(workspaceId, path, written, { baseHash: tab.baseHash, force: true });
        applyWritten(set, get, workspaceId, path, written, result.hash);
      } catch (error) {
        if (get().workspaceId === workspaceId) get().noteApiError(error);
        throw error;
      }
    });
  },

  reloadFromDisk: async (path) => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    await serialized(workspaceId, path, async () => {
      let file: IdeFile;
      try {
        file = await ideApi.readFile(workspaceId, path);
      } catch (error) {
        if (get().workspaceId === workspaceId) get().noteApiError(error);
        throw error;
      }
      if (get().workspaceId !== workspaceId) return;
      set({
        tabs: get().tabs.map((t) =>
          t.path === path
            ? { ...t, content: file.content, baseHash: file.hash, size: file.size, dirty: false, conflict: false }
            : t,
        ),
      });
      // Explicit "load from disk": the unsaved edits are given up on purpose.
      await clearDraft(workspaceId, path);
    });
  },

  readDisk: async (path) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    try {
      return await ideApi.readFile(workspaceId, path);
    } catch (error) {
      if (get().workspaceId === workspaceId) get().noteApiError(error);
      if (error instanceof IdeApiError && error.status === 404) return null;
      throw error;
    }
  },

  recheckFromDisk: async (path) => {
    const { workspaceId, blocked } = get();
    if (!workspaceId || blocked !== null) return;
    // A save in flight is about to move baseHash itself; comparing now would misfire.
    if (inflight.has(inflightKey(workspaceId, path))) return;
    const before = get().tabs.find((t) => t.path === path);
    if (!before || before.kind !== 'text') return;
    let file: IdeFile;
    try {
      file = await ideApi.readFile(workspaceId, path);
    } catch (error) {
      // A vanished or turned-binary file leaves the tab alone; only IDE-wide states matter here.
      if (get().workspaceId === workspaceId) get().noteApiError(error);
      return;
    }
    if (get().workspaceId !== workspaceId || inflight.has(inflightKey(workspaceId, path))) return;
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || tab.kind !== 'text' || file.hash === tab.baseHash) return;
    const untouched = !tab.dirty && tab.content === before.content && tab.baseHash === before.baseHash;
    if (untouched || tab.content === file.content) {
      // Clean tab, or the disk already holds exactly this buffer: adopt the disk version.
      set({
        tabs: get().tabs.map((t) =>
          t.path === path
            ? { ...t, content: file.content, baseHash: file.hash, size: file.size, dirty: false, conflict: false }
            : t,
        ),
      });
      if (tab.dirty) void clearDraft(workspaceId, path);
      return;
    }
    if (!tab.conflict) set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, conflict: true } : t)) });
  },

  noteApiError: (error) => {
    if (!(error instanceof IdeApiError) || error instanceof IdeConflictError) return;
    const { workspaceId, setBlocked } = get();
    if (error.status === 403) setBlocked('forbidden');
    // A 409 "target exists" is about one entry, not about the workspace.
    else if (error.status === 409 && error.reason === 'inactive') setBlocked('archived');
    else if (error.status === 404 && workspaceId) {
      // A 404 is either a vanished file or a vanished workspace; the root listing tells them apart.
      ideApi.tree(workspaceId, '.').then(
        () => undefined,
        (probe: unknown) => {
          if (get().workspaceId !== workspaceId || !(probe instanceof IdeApiError)) return;
          if (probe.status === 404) setBlocked('gone');
          else if (probe.status === 403) setBlocked('forbidden');
          else if (probe.status === 409 && probe.reason === 'inactive') setBlocked('archived');
        },
      );
    }
  },

  openInSplit: async (path) => {
    await get().openFile(path);
    if (get().tabs.some((t) => t.path === path)) set({ splitPath: path });
  },

  closeSplit: () => set({ splitPath: null }),

  setPanel: (panel) => set({ panel }),

  setSidebarWidth: (width) => {
    const sidebarWidth = clamp(Math.round(width), ...SIDEBAR_RANGE);
    set({ sidebarWidth });
    persistLayout(get());
  },

  setTerminalHeight: (height) => {
    const terminalHeight = clamp(Math.round(height), ...TERMINAL_RANGE);
    set({ terminalHeight });
    persistLayout(get());
  },

  setTerminalOpen: (open) => set({ terminalOpen: open }),

  setAgentOpen: (open) => {
    set({ agentOpen: open });
    persistLayout(get());
  },

  attachCodeRef: (ref) => {
    const { list, result } = addCodeRef(get().codeRefs, ref);
    if (result === 'added' || result === 'duplicate') {
      set({ codeRefs: list, agentOpen: true, codeRefFocusTick: get().codeRefFocusTick + 1 });
      persistLayout(get());
    }
    return result;
  },

  removeCodeRef: (index) => set({ codeRefs: get().codeRefs.filter((_, i) => i !== index) }),

  clearCodeRefs: () => set({ codeRefs: [] }),
  removeSentCodeRefs: (sent) => set({ codeRefs: get().codeRefs.filter((r) => !sent.includes(r)) }),

  setAgentWidth: (width) => {
    const agentWidth = clamp(Math.round(width), ...AGENT_RANGE);
    set({ agentWidth });
    persistLayout(get());
  },

  addTerminal: (initialInput) => {
    const id = nextTerminalId++;
    set({
      terminals: [...get().terminals, id],
      activeTerminal: id,
      terminalOpen: true,
      terminalInputs: initialInput === undefined ? get().terminalInputs : { ...get().terminalInputs, [id]: initialInput },
    });
  },

  closeTerminal: (id) => {
    const terminals = get().terminals.filter((t) => t !== id);
    const activeTerminal =
      get().activeTerminal === id ? (terminals[terminals.length - 1] ?? null) : get().activeTerminal;
    const terminalInputs = Object.fromEntries(
      Object.entries(get().terminalInputs).filter(([key]) => key !== String(id)),
    );
    set({ terminals, activeTerminal, terminalInputs, terminalOpen: terminals.length > 0 ? get().terminalOpen : false });
  },

  setActiveTerminal: (id) => set({ activeTerminal: id }),

  clearTerminalInput: (id) => {
    if (!(id in get().terminalInputs)) return;
    set({
      terminalInputs: Object.fromEntries(Object.entries(get().terminalInputs).filter(([key]) => key !== String(id))),
    });
  },

  openTerminalAt: (dir) => {
    // A new PTY starts in the last cwd any /exec left behind, not necessarily the
    // workspace root: always cd to an absolute path. `--` keeps a directory name
    // with a leading dash from being read as an option.
    const root = get().workspaceRoot;
    if (root === null) {
      if (dir === '.') set({ terminalOpen: true });
      else get().addTerminal(`cd -- ${shellQuote(dir)}\n`);
      return;
    }
    const base = root.replace(/\/+$/, '');
    const target = dir === '.' ? `${base}/` : `${base}/${dir}`;
    get().addTerminal(`cd -- ${shellQuote(target)}\n`);
  },

  setBlocked: (blocked) => set({ blocked }),

  applyWorkspaceChanged: (paths) => {
    const changed = [...new Set(paths.map(normalizeChangedPath))];
    if (changed.length === 0) return;
    const all = changed.includes('.');
    // A changed path may itself be an expanded folder (mkdir over a listed one, a move target).
    const dirs = all ? ['.'] : [...new Set(changed.flatMap((p) => [parentDir(p), p]))];
    const { treeRefresh, saveTick, tabs } = get();
    set({ treeRefresh: { seq: treeRefresh.seq + 1, dirs, all }, saveTick: saveTick + 1 });
    // recheckFromDisk adopts the disk version only for an untouched tab and skips saves in flight.
    const affected = tabs.filter(
      (t) => t.kind === 'text' && !t.dirty && (all || changed.some((p) => isUnder(t.path, p))),
    );
    for (const tab of affected) void get().recheckFromDisk(tab.path);
  },
}));
