import { create } from 'zustand';
import { isRecord } from '../lib/narrow';
import { ideApi, IdeApiError, IdeConflictError } from './ide-api';

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
}

export interface RevealTarget {
  path: string;
  line: number;
  column: number;
}

export type SidePanel = 'files' | 'search';
export type BlockedReason = null | 'archived' | 'gone' | 'forbidden';

interface IdeState {
  workspaceId: string | null;
  tabs: OpenTab[];
  activePath: string | null;
  /** Second editor group: file shown to the right of the active editor. */
  splitPath: string | null;
  panel: SidePanel;
  sidebarWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
  /** Terminal tabs: each id is one live PTY session component. */
  terminals: number[];
  activeTerminal: number | null;
  /** One-shot command typed into the terminal on next open (e.g. cd from the file tree). */
  terminalCommand: string | null;
  /** One-shot cursor target the editor applies once the file is shown. */
  reveal: RevealTarget | null;
  blocked: BlockedReason;

  setWorkspace: (workspaceId: string) => void;
  openFile: (path: string, sizeHint?: number) => Promise<void>;
  openFileAt: (path: string, line: number, column?: number) => Promise<void>;
  /** Returns the pending reveal for this path (and clears it), or null. */
  consumeReveal: (path: string) => RevealTarget | null;
  closeTab: (path: string) => void;
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
  openInSplit: (path: string) => Promise<void>;
  closeSplit: () => void;
  setPanel: (panel: SidePanel) => void;
  setSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  setTerminalOpen: (open: boolean) => void;
  addTerminal: () => void;
  closeTerminal: (id: number) => void;
  setActiveTerminal: (id: number) => void;
  openTerminalAt: (dir: string) => void;
  consumeTerminalCommand: () => string | null;
  setBlocked: (blocked: BlockedReason) => void;
}

const LAYOUT_KEY = 'dg.ide.layout';
const SIDEBAR_RANGE = [180, 560] as const;
const TERMINAL_RANGE = [120, 800] as const;

let nextTerminalId = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function loadLayout(): { sidebarWidth: number; terminalHeight: number } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const source = isRecord(parsed) ? parsed : {};
    return {
      sidebarWidth: clamp(numberOr(source.sidebarWidth, 260), ...SIDEBAR_RANGE),
      terminalHeight: clamp(numberOr(source.terminalHeight, 256), ...TERMINAL_RANGE),
    };
  } catch {
    return { sidebarWidth: 260, terminalHeight: 256 };
  }
}

function persistLayout(sidebarWidth: number, terminalHeight: number): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth, terminalHeight }));
  } catch {
    /* storage full/blocked — layout just won't persist */
  }
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Reads a file into a tab; 415/413 become placeholder tabs instead of errors. */
async function readTab(workspaceId: string, path: string, sizeHint: number): Promise<OpenTab> {
  try {
    const file = await ideApi.readFile(workspaceId, path);
    return {
      path,
      content: file.content,
      baseHash: file.hash,
      dirty: false,
      conflict: false,
      kind: 'text',
      size: file.size,
    };
  } catch (error) {
    if (error instanceof IdeApiError && (error.status === 415 || error.status === 413)) {
      return {
        path,
        content: '',
        baseHash: null,
        dirty: false,
        conflict: false,
        kind: error.status === 415 ? 'binary' : 'too-large',
        size: sizeHint,
      };
    }
    throw error;
  }
}

export const useIdeStore = create<IdeState>((set, get) => ({
  workspaceId: null,
  tabs: [],
  activePath: null,
  splitPath: null,
  panel: 'files',
  terminalOpen: false,
  terminals: [],
  activeTerminal: null,
  terminalCommand: null,
  reveal: null,
  blocked: null,
  ...loadLayout(),

  setWorkspace: (workspaceId) => {
    if (get().workspaceId !== workspaceId) {
      set({
        workspaceId,
        tabs: [],
        activePath: null,
        splitPath: null,
        reveal: null,
        blocked: null,
      });
    }
  },

  openFile: async (path, sizeHint = 0) => {
    const { workspaceId, tabs } = get();
    if (!workspaceId) return;
    if (tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }
    const tab = await readTab(workspaceId, path, sizeHint);
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

  closeTabsUnder: (pathPrefix) => {
    const tabs = get().tabs.filter((t) => !isUnder(t.path, pathPrefix));
    const active = get().activePath;
    const activePath = tabs.some((t) => t.path === active) ? active : (tabs[tabs.length - 1]?.path ?? null);
    const splitPath = tabs.some((t) => t.path === get().splitPath) ? get().splitPath : null;
    set({ tabs, activePath, splitPath });
  },

  renameTabsUnder: (from, to) => {
    const rename = (path: string): string => (isUnder(path, from) ? to + path.slice(from.length) : path);
    const { activePath, splitPath } = get();
    set({
      tabs: get().tabs.map((t) => (isUnder(t.path, from) ? { ...t, path: rename(t.path) } : t)),
      activePath: activePath === null ? null : rename(activePath),
      splitPath: splitPath === null ? null : rename(splitPath),
    });
  },

  setActive: (path) => set({ activePath: path }),

  edit: (path, content) => {
    set({
      tabs: get().tabs.map((t) =>
        t.path === path && t.kind === 'text' ? { ...t, content, dirty: content !== t.content || t.dirty } : t,
      ),
    });
  },

  save: async (path) => {
    const { workspaceId, tabs } = get();
    const tab = tabs.find((t) => t.path === path);
    if (!workspaceId || !tab || !tab.dirty) return { conflict: false };
    try {
      const result = await ideApi.writeFile(workspaceId, path, tab.content, { baseHash: tab.baseHash });
      set({
        tabs: get().tabs.map((t) =>
          t.path === path ? { ...t, baseHash: result.hash, dirty: false, conflict: false } : t,
        ),
      });
      return { conflict: false };
    } catch (error) {
      if (error instanceof IdeConflictError) {
        set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, conflict: true } : t)) });
        return { conflict: true };
      }
      throw error;
    }
  },

  forceSave: async (path) => {
    const { workspaceId, tabs } = get();
    const tab = tabs.find((t) => t.path === path);
    if (!workspaceId || !tab) return;
    const result = await ideApi.writeFile(workspaceId, path, tab.content, { baseHash: tab.baseHash, force: true });
    set({
      tabs: get().tabs.map((t) =>
        t.path === path ? { ...t, baseHash: result.hash, dirty: false, conflict: false } : t,
      ),
    });
  },

  reloadFromDisk: async (path) => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    const file = await ideApi.readFile(workspaceId, path);
    set({
      tabs: get().tabs.map((t) =>
        t.path === path
          ? { ...t, content: file.content, baseHash: file.hash, size: file.size, dirty: false, conflict: false }
          : t,
      ),
    });
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
    persistLayout(sidebarWidth, get().terminalHeight);
  },

  setTerminalHeight: (height) => {
    const terminalHeight = clamp(Math.round(height), ...TERMINAL_RANGE);
    set({ terminalHeight });
    persistLayout(get().sidebarWidth, terminalHeight);
  },

  setTerminalOpen: (open) => set({ terminalOpen: open }),

  addTerminal: () => {
    const id = nextTerminalId++;
    set({ terminals: [...get().terminals, id], activeTerminal: id, terminalOpen: true });
  },

  closeTerminal: (id) => {
    const terminals = get().terminals.filter((t) => t !== id);
    const activeTerminal =
      get().activeTerminal === id ? (terminals[terminals.length - 1] ?? null) : get().activeTerminal;
    set({ terminals, activeTerminal, terminalOpen: terminals.length > 0 ? get().terminalOpen : false });
  },

  setActiveTerminal: (id) => set({ activeTerminal: id }),

  openTerminalAt: (dir) => {
    // `--` keeps a directory name with a leading dash from being read as an option.
    set({ terminalOpen: true, terminalCommand: dir === '.' ? null : `cd -- ${shellQuote(dir)}\n` });
  },

  consumeTerminalCommand: () => {
    const command = get().terminalCommand;
    if (command !== null) set({ terminalCommand: null });
    return command;
  },

  setBlocked: (blocked) => set({ blocked }),
}));
