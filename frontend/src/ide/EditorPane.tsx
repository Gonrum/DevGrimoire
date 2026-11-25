import './monaco-setup';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import { editor as monacoEditor, Uri } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import Markdown from '../components/Markdown';
import Button from '../components/ui/Button';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';
import { NonTextTabView } from './EditorCards';
import { limitAwareMessage } from './limit-message';
import { IdeConfirmDialog, IdeDialog } from './IdeDialog';
import { selectionLines } from './code-refs';
import { useIdeStore, type BlockedReason, type OpenTab } from './ide-store';
import { isMarkdownPath, languageFromPath } from './language';
import { DEVGRIMOIRE_THEME } from './monaco-theme';
import { TERMINAL_SELECTOR } from './terminal-marker';

type CodeEditorInstance = Parameters<OnMount>[0];
type Slot = 'main' | 'split';
type MdMode = 'editor' | 'split' | 'preview';

const AUTO_SAVE_DELAY_MS = 1500;

const BLOCKED_TEXT: Record<Exclude<BlockedReason, null>, string> = {
  archived: 'ide.blockedArchived',
  gone: 'ide.blockedGone',
  forbidden: 'ide.blockedForbidden',
};

const MD_MODES: { mode: MdMode; label: string }[] = [
  { mode: 'editor', label: 'ide.mdEditor' },
  { mode: 'split', label: 'ide.mdSplit' },
  { mode: 'preview', label: 'ide.mdPreview' },
];

const DIFF_OPTIONS = {
  fontSize: 13,
  minimap: { enabled: false },
  automaticLayout: true,
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
} as const;

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

const SLOTS: readonly Slot[] = ['main', 'split'];

/**
 * Model URI per editor slot. The real file name gives the TS worker the right script kind
 * (.tsx → JSX). The slot prefix keeps main and split editor on separate models: each editor
 * syncs its model from the store, so two editors on one model would echo each other's edits.
 * Models outlive tab switches (undo history, cursor, scroll); EditorPane disposes them when
 * their tab closes or is renamed.
 */
function modelPath(slot: Slot, path: string): string {
  return `file:///${slot}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Disposes every slot model whose tab is not among `openPaths`. */
function disposeModelsExcept(openPaths: readonly string[]): void {
  const keep = new Set<string>();
  for (const path of openPaths) {
    for (const slot of SLOTS) keep.add(Uri.parse(modelPath(slot, path)).toString());
  }
  for (const model of monacoEditor.getModels()) {
    const { scheme, path } = model.uri;
    if (scheme !== 'file' || !SLOTS.some((slot) => path.startsWith(`/${slot}/`))) continue;
    if (!keep.has(model.uri.toString())) model.dispose();
  }
}

export function EditorPane() {
  const { t } = useTranslation();
  const { showError } = useToast();
  const tabs = useIdeStore((s) => s.tabs);
  const activePath = useIdeStore((s) => s.activePath);
  const splitPath = useIdeStore((s) => s.splitPath);
  const blocked = useIdeStore((s) => s.blocked);
  const reveal = useIdeStore((s) => s.reveal);
  const anyDirty = useIdeStore((s) => s.tabs.some((tab) => tab.dirty));
  const setActive = useIdeStore((s) => s.setActive);
  const closeTab = useIdeStore((s) => s.closeTab);
  const discardTab = useIdeStore((s) => s.discardTab);
  const edit = useIdeStore((s) => s.edit);
  const save = useIdeStore((s) => s.save);
  const forceSave = useIdeStore((s) => s.forceSave);
  const reloadFromDisk = useIdeStore((s) => s.reloadFromDisk);
  const readDisk = useIdeStore((s) => s.readDisk);
  const recheckFromDisk = useIdeStore((s) => s.recheckFromDisk);
  const closeSplit = useIdeStore((s) => s.closeSplit);

  /** Conflict diff: disk version (null = file no longer on disk) against the buffer. */
  const [diff, setDiff] = useState<{ path: string; disk: string | null } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  /** Dirty tab the user wants to close: asks save / discard first. */
  const [closing, setClosing] = useState<string | null>(null);
  const [mdMode, setMdMode] = useState<MdMode>('split');
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Path of the editor that last had focus — Ctrl+S saves that one. */
  const focusedPath = useRef<string | null>(null);
  const mainEditor = useRef<{ editor: CodeEditorInstance; path: string } | null>(null);
  const openTextPaths = useMemo(
    () => tabs.filter((tab) => tab.kind === 'text').map((tab) => tab.path).join('\u0000'),
    [tabs],
  );

  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  const splitTab = splitPath ? (tabs.find((tab) => tab.path === splitPath) ?? null) : null;
  const diffTab = diff ? (tabs.find((tab) => tab.path === diff.path) ?? null) : null;
  const closingTab = closing ? (tabs.find((tab) => tab.path === closing) ?? null) : null;
  const readOnly = blocked !== null;
  const showMdToggle = !splitTab && active?.kind === 'text' && isMarkdownPath(active.path);
  const mdView: MdMode = showMdToggle ? mdMode : 'editor';
  const twoColumns = splitTab !== null || mdView === 'split';

  const openDiff = useCallback(
    async (path: string): Promise<void> => {
      try {
        const file = await readDisk(path);
        setDiff({ path, disk: file ? file.content : null });
      } catch (error) {
        showError(errorMessage(error, t('ide.operationFailed')));
      }
    },
    [readDisk, showError, t],
  );

  const cancelAutoSave = useCallback((path: string): void => {
    const timer = timers.current.get(path);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(path);
  }, []);

  /*
   * Auto-save is armed only by an edit and never re-arms itself: a failed save
   * waits for the next keystroke instead of retrying in a loop.
   */
  const runAutoSave = useCallback(
    (path: string): void => {
      timers.current.delete(path);
      const state = useIdeStore.getState();
      const tab = state.tabs.find((candidate) => candidate.path === path);
      if (state.blocked !== null || !tab || tab.kind !== 'text' || !tab.dirty || tab.conflict) return;
      state.save(path).catch((error: unknown) => {
        showError(t('ide.autoSaveFailed', { name: baseName(path), message: limitAwareMessage(error, 'editor', t) }));
      });
    },
    [showError, t],
  );

  const onEdit = useCallback(
    (path: string, value: string): void => {
      edit(path, value);
      cancelAutoSave(path);
      timers.current.set(
        path,
        setTimeout(() => runAutoSave(path), AUTO_SAVE_DELAY_MS),
      );
    },
    [edit, cancelAutoSave, runAutoSave],
  );

  const saveNow = useCallback(
    (path: string): void => {
      cancelAutoSave(path);
      const state = useIdeStore.getState();
      const tab = state.tabs.find((candidate) => candidate.path === path);
      if (state.blocked !== null || !tab || tab.kind !== 'text') return;
      if (tab.conflict) {
        void openDiff(path);
        return;
      }
      save(path)
        .then((result) => {
          if (result.conflict) void openDiff(path);
        })
        .catch((error: unknown) => {
          showError(t('ide.saveFailed', { name: baseName(path), message: limitAwareMessage(error, 'editor', t) }));
        });
    },
    [cancelAutoSave, openDiff, save, showError, t],
  );

  // Ctrl/Cmd+S saves the focused editor's tab (capture phase: before the browser's own dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 's') return;
      // Inside a terminal Ctrl+S is XOFF for the shell, not "save".
      if (event.target instanceof Element && event.target.closest(TERMINAL_SELECTOR)) return;
      event.preventDefault();
      const state = useIdeStore.getState();
      const focused = focusedPath.current;
      const target = focused && (focused === state.activePath || focused === state.splitPath) ? focused : state.activePath;
      if (target) saveNow(target);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [saveNow]);

  // Pending auto-saves die with the pane; the drafts in IndexedDB keep the edits.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // No watcher yet: when the window regains focus, compare the active tab with the disk.
  useEffect(() => {
    let running = false;
    const check = (): void => {
      if (document.visibilityState !== 'visible' || running) return;
      const path = useIdeStore.getState().activePath;
      if (!path) return;
      running = true;
      recheckFromDisk(path)
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [recheckFromDisk]);

  // The browser's own leave-page prompt while anything is unsaved.
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy trigger for browsers that ignore preventDefault here.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  // Apply a pending cursor target (search hit) once its file is in the main editor.
  const applyReveal = useCallback((target: { editor: CodeEditorInstance; path: string }): void => {
    const pending = useIdeStore.getState().consumeReveal(target.path);
    if (!pending) return;
    const position = { lineNumber: pending.line, column: pending.column };
    target.editor.setPosition(position);
    target.editor.revealPositionInCenter(position);
    target.editor.focus();
  }, []);

  useEffect(() => {
    if (reveal && mainEditor.current?.path === reveal.path) applyReveal(mainEditor.current);
  }, [reveal, applyReveal]);

  const onFocusPath = useCallback((path: string): void => {
    focusedPath.current = path;
  }, []);

  /** Called on mount and after every model switch of the main editor. */
  const onMainShown = useCallback(
    (editorInstance: CodeEditorInstance, path: string): void => {
      const known = mainEditor.current?.editor === editorInstance;
      const target = { editor: editorInstance, path };
      mainEditor.current = target;
      if (!known) {
        editorInstance.onDidDispose(() => {
          if (mainEditor.current?.editor === editorInstance) mainEditor.current = null;
        });
      }
      applyReveal(target);
    },
    [applyReveal],
  );

  /*
   * A model lives as long as its tab: closing or renaming a tab disposes it (a renamed
   * tab gets a fresh model under the new path). Runs after the editors' own effects, so
   * an editor has already switched away from a model before it is disposed here.
   */
  // Leaving the IDE keeps the models of the still-open tabs: the store keeps those tabs, and
  // the next mount reuses the models (and disposes any that no longer have a tab).
  useEffect(() => {
    disposeModelsExcept(openTextPaths === '' ? [] : openTextPaths.split('\u0000'));
  }, [openTextPaths]);

  const requestClose = (tab: OpenTab): void => {
    if (tab.dirty) {
      setClosing(tab.path);
      return;
    }
    cancelAutoSave(tab.path);
    closeTab(tab.path);
  };

  const saveAndClose = (path: string): void => {
    setClosing(null);
    cancelAutoSave(path);
    save(path)
      .then((result) => {
        if (result.conflict) {
          void openDiff(path);
          return;
        }
        // Only close once the buffer is really on disk.
        if (useIdeStore.getState().tabs.find((tab) => tab.path === path)?.dirty === false) closeTab(path);
      })
      .catch((error: unknown) => {
        showError(t('ide.saveFailed', { name: baseName(path), message: limitAwareMessage(error, 'editor', t) }));
      });
  };

  const resolveDiff = (choice: 'mine' | 'disk'): void => {
    if (!diff) return;
    const { path } = diff;
    setDiffBusy(true);
    (choice === 'mine' ? forceSave(path) : reloadFromDisk(path))
      .then(() => setDiff(null))
      .catch((error: unknown) => showError(errorMessage(error, t('ide.operationFailed'))))
      .finally(() => setDiffBusy(false));
  };

  const renderSlot = (tab: OpenTab, slot: Slot) =>
    tab.kind === 'text' ? (
      // One editor per slot across tab switches: it swaps models instead of remounting.
      <CodeEditor
        key={`${slot}:code`}
        tab={tab}
        slot={slot}
        readOnly={readOnly}
        onEdit={onEdit}
        onFocusPath={onFocusPath}
        onShown={slot === 'main' ? onMainShown : undefined}
      />
    ) : (
      <NonTextTabView key={`${slot}:${tab.path}`} tab={tab} />
    );

  return (
    // min-w-0/overflow-hidden: Monaco sets explicit pixel widths and would otherwise blow the layout open.
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center overflow-x-auto border-b border-gray-700 bg-gray-800">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-1.5 text-sm ${
              tab.path === activePath ? 'border-cyan-400 bg-gray-900 text-gray-200' : 'border-transparent text-gray-400'
            }`}
            onAuxClick={(event) => {
              if (event.button === 1) requestClose(tab);
            }}
          >
            <button onClick={() => setActive(tab.path)} className="font-mono" title={tab.path}>
              {baseName(tab.path)}
              {tab.dirty && <span className="ml-1 text-cyan-400" title={t('ide.unsaved')}>●</span>}
              {tab.conflict && <span className="ml-1 text-amber-400" title={t('ide.conflictShort')}>⚠</span>}
            </button>
            <button
              onClick={() => requestClose(tab)}
              className="text-gray-500 hover:text-gray-200"
              title={t('ide.close')}
              aria-label={t('ide.close')}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {blocked && (
        <div className="shrink-0 border-b border-red-900 bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {t(BLOCKED_TEXT[blocked])}
        </div>
      )}

      {active?.conflict && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-900 bg-amber-900/20 px-4 py-2 text-sm text-amber-300">
          <span>{t('ide.conflictBanner')}</span>
          <Button size="sm" variant="warning" onClick={() => void openDiff(active.path)}>
            {t('ide.compare')}
          </Button>
        </div>
      )}

      {showMdToggle && (
        <div className="flex shrink-0 justify-end gap-1 border-b border-gray-700 bg-gray-800 px-2 py-1">
          {MD_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              className={`rounded-sm px-2 py-0.5 text-xs ${
                mdMode === mode ? 'bg-cyan-400/15 text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }`}
              onClick={() => setMdMode(mode)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}

      <div className={`grid min-h-0 flex-1 ${twoColumns ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div className="relative min-h-0 min-w-0 overflow-hidden">
          {!active ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-gray-500">{t('ide.noFileOpen')}</p>
            </div>
          ) : mdView === 'preview' ? (
            <MarkdownPreview content={active.content} />
          ) : (
            renderSlot(active, 'main')
          )}
        </div>
        {splitTab && (
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-gray-700">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-700 bg-gray-800 px-3 py-1.5">
              <span className="truncate font-mono text-xs text-gray-400" title={splitTab.path}>
                {baseName(splitTab.path)}
                {splitTab.dirty && <span className="ml-1 text-cyan-400">●</span>}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {splitTab.conflict && (
                  <button className="text-xs text-amber-400 hover:text-amber-300" onClick={() => void openDiff(splitTab.path)}>
                    ⚠ {t('ide.compare')}
                  </button>
                )}
                <button className="text-xs text-gray-400 hover:text-gray-200" title={t('ide.closeSplit')} onClick={closeSplit}>
                  ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">{renderSlot(splitTab, 'split')}</div>
          </div>
        )}
        {!splitTab && mdView === 'split' && active && (
          <div className="min-h-0 min-w-0 border-l border-gray-700">
            <MarkdownPreview content={active.content} />
          </div>
        )}
      </div>

      {diff && diffTab && (
        <IdeDialog
          size="fill"
          title={t('ide.conflictTitle', { path: diffTab.path })}
          onClose={() => setDiff(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDiff(null)}>
                {t('ide.cancel')}
              </Button>
              <Button variant="secondary" disabled={diffBusy || diff.disk === null || readOnly} onClick={() => resolveDiff('disk')}>
                {t('ide.takeDisk')}
              </Button>
              <Button variant="primary" disabled={diffBusy || readOnly} onClick={() => resolveDiff('mine')}>
                {t('ide.keepMine')}
              </Button>
            </>
          }
        >
          <div className="flex shrink-0 justify-between gap-4 border-b border-gray-700 px-4 py-2 font-mono text-xs text-gray-400">
            <span>← {t('ide.diskVersion')}</span>
            <span>{t('ide.myVersion')} →</span>
          </div>
          {diff.disk === null && (
            <div className="shrink-0 border-b border-gray-700 px-4 py-2 text-xs text-amber-300">{t('ide.diskMissing')}</div>
          )}
          <div className="min-h-0 flex-1">
            <ConflictDiff path={diffTab.path} original={diff.disk ?? ''} modified={diffTab.content} />
          </div>
        </IdeDialog>
      )}

      {closingTab && (
        <IdeConfirmDialog
          title={t('ide.closeDirtyTitle')}
          message={t('ide.closeDirtyText', { name: baseName(closingTab.path) })}
          cancelLabel={t('ide.cancel')}
          onCancel={() => setClosing(null)}
          actions={[
            {
              label: t('ide.discard'),
              variant: 'danger',
              onClick: () => {
                setClosing(null);
                cancelAutoSave(closingTab.path);
                void discardTab(closingTab.path);
              },
            },
            // Saving is impossible while blocked or in conflict: offer to keep the draft instead.
            closingTab.conflict || readOnly
              ? {
                  label: t('ide.closeKeepDraft'),
                  onClick: () => {
                    setClosing(null);
                    cancelAutoSave(closingTab.path);
                    closeTab(closingTab.path);
                  },
                }
              : { label: t('ide.save'), variant: 'primary', onClick: () => saveAndClose(closingTab.path) },
          ]}
        />
      )}
    </div>
  );
}

/**
 * Side-by-side diff of the conflict dialog. The wrapper keeps both models alive past the
 * widget: letting the library dispose them first makes Monaco throw "TextModel got disposed
 * before DiffEditorWidget model got reset" when the dialog closes.
 */
function ConflictDiff({ path, original, modified }: { path: string; original: string; modified: string }) {
  const diffEditor = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  useEffect(
    () => () => {
      // Runs before the widget is torn down, so the models are still attached here.
      const models = diffEditor.current?.getModel();
      setTimeout(() => {
        models?.original.dispose();
        models?.modified.dispose();
      }, 0);
    },
    [],
  );
  return (
    <DiffEditor
      theme={DEVGRIMOIRE_THEME}
      language={languageFromPath(path)}
      original={original}
      modified={modified}
      options={DIFF_OPTIONS}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        diffEditor.current = editor;
      }}
    />
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto bg-gray-900 p-6">
      <Markdown>{content}</Markdown>
    </div>
  );
}

interface CodeEditorProps {
  tab: OpenTab;
  slot: Slot;
  readOnly: boolean;
  onEdit: (path: string, value: string) => void;
  onFocusPath: (path: string) => void;
  /** Called once the editor shows `path`: after mount and after every model switch. */
  onShown?: (editor: CodeEditorInstance, path: string) => void;
}

/**
 * The EOL Monaco would detect for `text` (majority rule, like its text buffer), or null when
 * there is nothing to decide: no line break at all, or mixed endings (Monaco normalizes those
 * to the majority anyway; forcing it here would make the tab dirty without an edit).
 */
function pureEol(text: string): monacoEditor.EndOfLineSequence | null {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lf += 1;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
  }
  if (lf === 0 || (crlf !== 0 && crlf !== lf)) return null;
  return crlf === lf ? monacoEditor.EndOfLineSequence.CRLF : monacoEditor.EndOfLineSequence.LF;
}

/** baseHash whose content a model's EOL was last matched against (per model, dies with it). */
const eolSyncedFor = new WeakMap<monacoEditor.ITextModel, string | null>();

/**
 * Brings a model in line with its tab: external updates (reload from disk, silent
 * re-check, draft restore, edits in the other slot) and kept models that were not shown
 * while their tab changed. The comparison ignores line-break style — the model stores one
 * EOL, the EOL step below handles that — so a mixed-EOL file is not rewritten (and its
 * cursor reset) on every tab switch.
 */
function syncModel(model: monacoEditor.ITextModel, content: string, baseHash: string | null): void {
  const value = model.getValue();
  if (value !== content && value !== content.replace(/\r\n|\r|\n/g, model.getEOL())) {
    // pushEditOperations keeps the undo stack and also works on a read-only editor.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
    model.pushStackElement();
  }
  /*
   * A new disk version reaches the model as an edit, and an edit is converted to the
   * model's current EOL. If the file's EOL changed on disk, the model would keep the old
   * one and the next save would rewrite every line ending. Keyed by baseHash so typing
   * does not rescan the buffer.
   */
  const first = !eolSyncedFor.has(model);
  if (!first && eolSyncedFor.get(model) === baseHash) return;
  eolSyncedFor.set(model, baseHash);
  const current = model.getEOL() === '\r\n' ? monacoEditor.EndOfLineSequence.CRLF : monacoEditor.EndOfLineSequence.LF;
  // A new model detects the EOL from its content and keeps it (CRLF stays CRLF). Content
  // without any line break has nothing to detect — pin LF there instead of the OS default.
  const wanted = pureEol(content) ?? (first && !/[\r\n]/.test(content) ? monacoEditor.EndOfLineSequence.LF : null);
  if (wanted !== null && wanted !== current) model.setEOL(wanted);
}

/**
 * One Monaco instance per slot. Switching tabs swaps the model (`path` prop with
 * `keepCurrentModel`), so undo history, cursor and scroll position survive; the editor
 * library saves and restores the view state per model path.
 */
function CodeEditor({ tab, slot, readOnly, onEdit, onFocusPath, onShown }: CodeEditorProps) {
  const { path, content, baseHash } = tab;
  const { t } = useTranslation();
  const { showError } = useToast();
  const uri = modelPath(slot, path);
  const editorRef = useRef<CodeEditorInstance | null>(null);
  /** Set while this component writes into the model itself: no echo into the store. */
  const syncing = useRef(false);
  /** Latest props for callbacks Monaco keeps (onMount is captured once by the library). */
  const latest = useRef({ path, content, baseHash, onFocusPath, onShown });
  useLayoutEffect(() => {
    latest.current = { path, content, baseHash, onFocusPath, onShown };
  });
  const options = useMemo(
    () => ({ fontSize: 13, minimap: { enabled: false }, automaticLayout: true, tabSize: 2, readOnly }),
    [readOnly],
  );
  const onChange = useCallback(
    (value: string | undefined) => {
      if (!syncing.current) onEdit(path, value ?? '');
    },
    [onEdit, path],
  );

  const syncShown = useCallback((editorInstance: CodeEditorInstance): void => {
    const model = editorInstance.getModel();
    if (!model) return;
    // The store, not this render's props: by the time an effect runs the user may already
    // have typed on (model and store move together), and older props would undo that.
    const live = useIdeStore.getState().tabs.find((candidate) => candidate.path === latest.current.path);
    const content = live?.content ?? latest.current.content;
    const hash = live ? live.baseHash : latest.current.baseHash;
    syncing.current = true;
    try {
      syncModel(model, content, hash);
    } finally {
      syncing.current = false;
    }
  }, []);

  /*
   * The model is fed here instead of through the library's `value` prop: that prop replaces
   * the whole text on any difference (also a mere EOL normalization) and resets the undo
   * stack in a read-only editor. Runs after the library's own effects, which have already
   * swapped the model and restored its view state. While typing, model and store hold the
   * same text, so this is one string compare per keystroke.
   */
  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    syncShown(editorInstance);
  }, [uri, baseHash, content, syncShown]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (editorInstance) latest.current.onShown?.(editorInstance, latest.current.path);
  }, [uri]);

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
    // The model may be a kept one from an earlier mount of this slot.
    syncShown(editorInstance);
    editorInstance.onDidFocusEditorText(() => latest.current.onFocusPath(latest.current.path));
    editorInstance.onDidDispose(() => {
      if (editorRef.current === editorInstance) editorRef.current = null;
    });
    latest.current.onShown?.(editorInstance, latest.current.path);
    // Label is read once at mount; a language switch applies on the next editor mount.
    const attachAction = editorInstance.addAction({
      id: 'devgrimoire.attachSelectionToAgent',
      label: t('ide.agent.attachSelection'),
      contextMenuGroupId: 'devgrimoire',
      contextMenuOrder: 1,
      precondition: 'editorHasSelection',
      run: (ed) => {
        const model = ed.getModel();
        const selection = ed.getSelection();
        if (!model || !selection || selection.isEmpty()) return;
        const { startLine, endLine } = selectionLines(selection);
        const currentPath = latest.current.path;
        const unsaved = useIdeStore.getState().tabs.find((tb) => tb.path === currentPath)?.dirty === true;
        const result = useIdeStore.getState().attachCodeRef({
          kind: 'selection',
          path: currentPath,
          startLine,
          endLine,
          text: model.getValueInRange(selection),
          ...(unsaved ? { unsaved: true } : {}),
        });
        if (result === 'too-large') showError(t('ide.agent.attachTooLarge'));
        else if (result === 'full') showError(t('ide.agent.attachFull'));
      },
    });
    editorInstance.onDidDispose(() => attachAction.dispose());
  };

  return (
    <Editor
      path={uri}
      keepCurrentModel
      theme={DEVGRIMOIRE_THEME}
      language={languageFromPath(path)}
      // Only seeds a model the library creates (new tab, renamed tab); updates go through syncModel.
      defaultValue={content}
      onChange={onChange}
      onMount={onMount}
      options={options}
    />
  );
}
