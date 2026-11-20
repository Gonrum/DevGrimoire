import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import ConfirmButton from '../components/ui/ConfirmButton';
import { useToast } from '../components/Toast';
import { errorMessage, isUnknownArray } from '../lib/narrow';
import { FileIcon, FolderIcon } from './FileIcon';
import { ideApi, IdeApiError, type IdeTreeEntry } from './ide-api';
import { useIdeStore } from './ide-store';
import { useWorkspaceFileTree } from './useWorkspaceFileTree';

interface FileTreeProps {
  workspaceId: string;
  activePath: string | null;
  onOpenFile: (path: string, size?: number) => void;
}

interface CreateDraft {
  parentDir: string;
  type: 'file' | 'dir';
}

interface MenuState {
  x: number;
  y: number;
  /** null = the panel background (workspace root). */
  entry: IdeTreeEntry | null;
}

interface MenuItem {
  label: string;
  action: () => void;
  /** Destructive item, rendered as a two-step ConfirmButton. */
  danger?: boolean;
}

interface UploadProgress {
  name: string;
  index: number;
  total: number;
  fraction: number;
}

function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/') || '.';
}

function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

const DRAG_TYPE = 'application/x-dg-path';

/** localStorage key prefix holding the expanded folder paths per workspace, so an F5 reopens them. */
const EXPANDED_KEY = 'dg.ide.filetree.expanded.';

function isHeavyPath(path: string): boolean {
  return path.split('/').includes('node_modules');
}

function loadExpanded(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY + workspaceId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isUnknownArray(parsed)) return [];
    // node_modules is never re-expanded automatically: it can hold thousands of entries.
    return parsed.filter((p): p is string => typeof p === 'string' && !isHeavyPath(p));
  } catch {
    return [];
  }
}

function persistExpanded(workspaceId: string, paths: string[]): void {
  try {
    localStorage.setItem(EXPANDED_KEY + workspaceId, JSON.stringify(paths));
  } catch {
    /* storage full/blocked — expansion just won't persist */
  }
}

/**
 * Splits a drop into plain files and a "directory was dropped" flag. Must run
 * synchronously inside the drop handler: the DataTransfer is emptied afterwards.
 */
function collectDroppedFiles(dt: DataTransfer): { files: File[]; hadDirectory: boolean } {
  const files: File[] = [];
  let hadDirectory = false;
  if (dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      if (item.webkitGetAsEntry()?.isDirectory) {
        hadDirectory = true;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else {
    files.push(...Array.from(dt.files));
  }
  return { files, hadDirectory };
}

export function FileTree({ workspaceId, activePath, onOpenFile }: FileTreeProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const { byDir, truncatedDirs, expanded, rootError, errors, toggleDir, expandDir, loadDir, refresh } =
    useWorkspaceFileTree(workspaceId);
  const closeTabsUnder = useIdeStore((s) => s.closeTabsUnder);
  const renameTabsUnder = useIdeStore((s) => s.renameTabsUnder);
  const openTerminalAt = useIdeStore((s) => s.openTerminalAt);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const uploading = useRef(false);

  // Gate persistence until the initial restore has run, so we don't clobber storage with [].
  const restored = useRef<string | null>(null);

  // Restore the folders that were expanded before the last F5 (re-expanding loads them).
  useEffect(() => {
    for (const path of loadExpanded(workspaceId)) expandDir(path);
    restored.current = workspaceId;
  }, [workspaceId, expandDir]);

  // Persist the expanded set (minus the always-open root) whenever it changes.
  useEffect(() => {
    if (restored.current !== workspaceId) return;
    persistExpanded(workspaceId, [...expanded].filter((p) => p !== '.'));
  }, [workspaceId, expanded]);

  /** A 409 from move/create means the target name is taken: say so specifically. */
  const explain = (e: unknown): string =>
    e instanceof IdeApiError && e.status === 409 ? t('ide.alreadyExists') : errorMessage(e, t('ide.operationFailed'));

  const nameTaken = (dir: string, name: string): boolean =>
    !name.includes('/') && (byDir[dir] ?? []).some((e) => e.name === name);

  const guard = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(explain(e));
    }
  };

  const startCreate = (parentDir: string, type: 'file' | 'dir'): void => {
    if (parentDir !== '.') expandDir(parentDir);
    setRenaming(null);
    setDraft({ parentDir, type });
  };

  const create = async (name: string): Promise<void> => {
    if (!draft) return;
    if (nameTaken(draft.parentDir, name)) throw new Error(t('ide.alreadyExists'));
    const path = joinPath(draft.parentDir, name);
    if (draft.type === 'dir') {
      await ideApi.mkdir(workspaceId, path);
    } else {
      await ideApi.writeFile(workspaceId, path, '', { baseHash: null });
    }
    setDraft(null);
    await refresh();
    if (draft.type === 'file') onOpenFile(path);
  };

  const rename = async (entry: IdeTreeEntry, newName: string): Promise<void> => {
    const parent = parentOf(entry.path);
    const to = joinPath(parent, newName);
    if (to !== entry.path) {
      if (nameTaken(parent, newName)) throw new Error(t('ide.alreadyExists'));
      await ideApi.move(workspaceId, entry.path, to);
      renameTabsUnder(entry.path, to);
      await refresh();
    }
    setRenaming(null);
  };

  const remove = (entry: IdeTreeEntry): Promise<void> =>
    guard(async () => {
      await ideApi.remove(workspaceId, entry.path);
      closeTabsUnder(entry.path);
      await refresh();
    });

  const move = (from: string, destDir: string): Promise<void> =>
    guard(async () => {
      if (from === destDir || destDir.startsWith(`${from}/`)) return;
      if (parentOf(from) === destDir) return;
      const name = from.split('/').pop() ?? from;
      const to = joinPath(destDir, name);
      if (nameTaken(destDir, name)) throw new Error(t('ide.alreadyExists'));
      await ideApi.move(workspaceId, from, to);
      renameTabsUnder(from, to);
      if (destDir !== '.') expandDir(destDir);
      await refresh();
    });

  const startUpload = (dir: string): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      void doUpload(dir, Array.from(input.files ?? []));
    };
    input.click();
  };

  /** Uploads one file after another; asks before overwriting an existing target. */
  const doUpload = async (dir: string, files: File[]): Promise<void> => {
    if (files.length === 0 || uploading.current) return;
    uploading.current = true;
    setError(null);
    let done = 0;
    try {
      for (const [index, file] of files.entries()) {
        const progress = (fraction: number): void =>
          setUpload({ name: file.name, index: index + 1, total: files.length, fraction });
        progress(0);
        try {
          try {
            await ideApi.upload(workspaceId, dir, file, { onProgress: progress });
          } catch (e) {
            if (!(e instanceof IdeApiError) || e.status !== 409) throw e;
            if (!window.confirm(t('ide.overwriteConfirm', { name: file.name }))) continue;
            await ideApi.upload(workspaceId, dir, file, { overwrite: true, onProgress: progress });
          }
          done += 1;
        } catch (e) {
          if (e instanceof IdeApiError && e.status === 413) {
            showError(t('ide.uploadTooLarge', { name: file.name }));
          } else {
            showError(`${file.name}: ${errorMessage(e, t('ide.operationFailed'))}`);
          }
        }
      }
    } finally {
      uploading.current = false;
      setUpload(null);
      if (dir !== '.') expandDir(dir);
      await refresh();
    }
    if (done > 0) showSuccess(t('ide.uploadDone', { count: done }));
  };

  const dropFiles = (dt: DataTransfer, dir: string): void => {
    const { files, hadDirectory } = collectDroppedFiles(dt);
    if (hadDirectory) showError(t('ide.uploadNoDirectories'));
    void doUpload(dir, files);
  };

  const copyPath = (path: string): void => {
    navigator.clipboard.writeText(path).catch(() => {
      showError(t('ide.copyPathFailed'));
    });
  };

  const menuItemsFor = (state: MenuState): MenuItem[] => {
    const entry = state.entry;
    if (!entry) {
      return [
        { label: t('ide.newFile'), action: () => startCreate('.', 'file') },
        { label: t('ide.newFolder'), action: () => startCreate('.', 'dir') },
        { label: t('ide.upload'), action: () => startUpload('.') },
        { label: t('ide.openInTerminal'), action: () => openTerminalAt('.') },
      ];
    }
    if (entry.type === 'dir') {
      return [
        { label: t('ide.newFile'), action: () => startCreate(entry.path, 'file') },
        { label: t('ide.newFolder'), action: () => startCreate(entry.path, 'dir') },
        { label: t('ide.rename'), action: () => setRenaming(entry.path) },
        { label: t('ide.delete'), danger: true, action: () => void remove(entry) },
        { label: t('ide.copyPath'), action: () => copyPath(entry.path) },
        { label: t('ide.upload'), action: () => startUpload(entry.path) },
        { label: t('ide.openInTerminal'), action: () => openTerminalAt(entry.path) },
      ];
    }
    return [
      { label: t('ide.openToSide'), action: () => void useIdeStore.getState().openInSplit(entry.path).catch((e: unknown) => showError(errorMessage(e))) },
      { label: t('ide.rename'), action: () => setRenaming(entry.path) },
      { label: t('ide.delete'), danger: true, action: () => void remove(entry) },
      { label: t('ide.copyPath'), action: () => copyPath(entry.path) },
      { label: t('ide.openInTerminal'), action: () => openTerminalAt(parentOf(entry.path)) },
    ];
  };

  const openMenu = (event: React.MouseEvent, entry: IdeTreeEntry | null): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const renderDir = (dirPath: string, depth: number): React.ReactNode => {
    const entries = byDir[dirPath] ?? [];
    return (
      <>
        {draft?.parentDir === dirPath && (
          <NameRow
            depth={depth}
            placeholder={draft.type === 'dir' ? t('ide.newFolder') : t('ide.newFile')}
            onSubmit={create}
            onCancel={() => setDraft(null)}
            describe={explain}
          />
        )}
        {entries.map((entry) => {
          // Dropping on a file row targets the folder next to it.
          const dropDir = entry.type === 'dir' ? entry.path : parentOf(entry.path);
          return renaming === entry.path ? (
            <NameRow
              key={entry.path}
              depth={depth}
              placeholder={t('ide.rename')}
              initial={entry.name}
              onSubmit={(name) => rename(entry, name)}
              onCancel={() => setRenaming(null)}
              describe={explain}
            />
          ) : (
            <Row
              key={entry.path}
              entry={entry}
              depth={depth}
              expanded={expanded.has(entry.path)}
              active={entry.path === activePath}
              isDropTarget={dropTarget === entry.path}
              onToggle={() => toggleDir(entry.path)}
              onOpen={() => onOpenFile(entry.path, entry.size)}
              onMenu={(event) => openMenu(event, entry)}
              onDropPath={(from) => void move(from, dropDir)}
              onDropData={(dt) => dropFiles(dt, dropDir)}
              onDropHover={(over) => setDropTarget(over ? dropDir : null)}
            >
              {entry.type === 'dir' && expanded.has(entry.path) ? (
                <>
                  {renderDir(entry.path, depth + 1)}
                  {errors[entry.path] && (
                    <DirError
                      depth={depth + 1}
                      message={errors[entry.path]}
                      retryLabel={t('ide.retry')}
                      onRetry={() => void loadDir(entry.path)}
                    />
                  )}
                  {truncatedDirs.has(entry.path) && <TruncatedHint depth={depth + 1} text={t('ide.truncated')} />}
                </>
              ) : null}
            </Row>
          );
        })}
      </>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-700 px-3 py-1.5">
        <span className="text-xs uppercase tracking-wide text-gray-400">{t('ide.files')}</span>
        <div className="flex gap-1 text-gray-400">
          <button
            title={t('ide.newFile')}
            aria-label={t('ide.newFile')}
            className="rounded-sm p-1 hover:bg-gray-800 hover:text-gray-200"
            onClick={() => startCreate(activePath ? parentOf(activePath) : '.', 'file')}
          >
            <FilePlus className="h-4 w-4" />
          </button>
          <button
            title={t('ide.newFolder')}
            aria-label={t('ide.newFolder')}
            className="rounded-sm p-1 hover:bg-gray-800 hover:text-gray-200"
            onClick={() => startCreate(activePath ? parentOf(activePath) : '.', 'dir')}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            title={t('ide.refresh')}
            aria-label={t('ide.refresh')}
            className="rounded-sm p-1 hover:bg-gray-800 hover:text-gray-200"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>
      {(error ?? rootError) && (
        <button
          className="shrink-0 truncate px-3 py-1 text-left text-xs text-red-400 hover:bg-gray-800"
          title={error ?? rootError?.message}
          onClick={() => setError(null)}
        >
          {error ?? rootError?.message}
        </button>
      )}
      <div
        className={`min-h-0 flex-1 overflow-auto py-2 text-sm ${dropTarget === '.' ? 'bg-cyan-400/5' : ''}`}
        onContextMenu={(event) => openMenu(event, null)}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget('.');
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget) setDropTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropTarget(null);
          const from = event.dataTransfer.getData(DRAG_TYPE);
          if (from) void move(from, '.');
          else dropFiles(event.dataTransfer, '.');
        }}
      >
        {renderDir('.', 0)}
        {errors['.'] && (
          <DirError depth={0} message={errors['.']} retryLabel={t('ide.retry')} onRetry={() => void loadDir('.')} />
        )}
        {truncatedDirs.has('.') && <TruncatedHint depth={0} text={t('ide.truncated')} />}
      </div>
      {upload && (
        <div className="shrink-0 border-t border-gray-700 px-3 py-1.5 text-xs text-gray-400">
          <div className="truncate">
            {t('ide.uploading', { name: upload.name, index: upload.index, total: upload.total })}
          </div>
          <progress className="mt-1 h-1 w-full" max={1} value={upload.fraction} />
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function DirError({ depth, message, retryLabel, onRetry }: { depth: number; message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-red-400" style={{ paddingLeft: `${depth * 12 + 24}px` }}>
      <span className="truncate" title={message}>{message}</span>
      <button className="shrink-0 text-cyan-400 hover:text-cyan-300" onClick={onRetry}>{retryLabel}</button>
    </div>
  );
}

function TruncatedHint({ depth, text }: { depth: number; text: string }) {
  return (
    <div className="px-2 py-1 text-xs italic text-gray-500" style={{ paddingLeft: `${depth * 12 + 24}px` }}>
      {text}
    </div>
  );
}

interface NameRowProps {
  depth: number;
  placeholder: string;
  initial?: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
  /** Turns a thrown error into the (translated) message shown under the input. */
  describe: (e: unknown) => string;
}

function NameRow({ depth, placeholder, initial, onSubmit, onCancel, describe }: NameRowProps) {
  const [name, setName] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === initial) {
      onCancel();
      return;
    }
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(describe(e));
    }
  };

  return (
    <div className="px-2 py-1" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
      <input
        autoFocus
        className="w-full rounded-sm border border-gray-700 bg-gray-800 px-2 py-0.5 font-mono text-sm text-gray-200 outline-hidden focus:border-cyan-400"
        placeholder={placeholder}
        value={name}
        onFocus={(event) => {
          // Pre-select the basename (without extension) when renaming.
          const dot = event.target.value.lastIndexOf('.');
          event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
        }}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={onCancel}
      />
      {error && <div className="px-1 pt-0.5 text-xs text-red-400">{error}</div>}
    </div>
  );
}

interface RowProps {
  entry: IdeTreeEntry;
  depth: number;
  expanded: boolean;
  active: boolean;
  isDropTarget: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (event: React.MouseEvent) => void;
  onDropPath: (from: string) => void;
  onDropData: (dt: DataTransfer) => void;
  onDropHover: (over: boolean) => void;
  children: React.ReactNode;
}

function Row({
  entry,
  depth,
  expanded,
  active,
  isDropTarget,
  onToggle,
  onOpen,
  onMenu,
  onDropPath,
  onDropData,
  onDropHover,
  children,
}: RowProps) {
  const isDir = entry.type === 'dir';
  return (
    <>
      <button
        draggable
        className={`flex w-full items-center gap-1 truncate px-2 py-1 text-left font-mono ${
          active ? 'bg-cyan-400/15 text-cyan-400' : 'text-gray-200 hover:bg-gray-800/50'
        } ${isDropTarget ? 'bg-cyan-400/10 outline outline-1 outline-cyan-400/40' : ''}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => (isDir ? onToggle() : onOpen())}
        onContextMenu={onMenu}
        onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, entry.path)}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDropHover(true);
        }}
        onDragLeave={() => onDropHover(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDropHover(false);
          const from = event.dataTransfer.getData(DRAG_TYPE);
          if (from) onDropPath(from);
          else onDropData(event.dataTransfer);
        }}
      >
        <span className="w-3 shrink-0 text-gray-500">{isDir ? (expanded ? '▾' : '▸') : ''}</span>
        {isDir ? <FolderIcon open={expanded} /> : <FileIcon name={entry.name} />}
        <span className="truncate">{entry.name}</span>
      </button>
      {children}
    </>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the menu inside the viewport (it opens near the cursor).
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 16),
  };

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-50 min-w-44 rounded-sm border border-gray-700 bg-gray-800 py-1 shadow-lg"
    >
      {items.map((item) =>
        item.danger ? (
          <div key={item.label} className="px-2 py-1">
            <ConfirmButton
              label={item.label}
              confirmLabel={`${item.label}?`}
              size="sm"
              variant="danger"
              className="w-full text-left"
              onConfirm={() => {
                item.action();
                onClose();
              }}
            />
          </div>
        ) : (
          <button
            key={item.label}
            className="block w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-700"
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
