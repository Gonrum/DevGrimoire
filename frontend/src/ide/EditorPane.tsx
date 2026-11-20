import './monaco-setup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import { editor as monacoEditor } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import Markdown from '../components/Markdown';
import Button from '../components/ui/Button';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';
import { NonTextTabView } from './EditorCards';
import { IdeConfirmDialog, IdeDialog } from './IdeDialog';
import { useIdeStore, type BlockedReason, type OpenTab } from './ide-store';
import { isMarkdownPath, languageFromPath } from './language';
import { DEVGRIMOIRE_THEME } from './monaco-theme';

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

/**
 * Model URI per editor slot. The real file name gives the TS worker the right script kind
 * (.tsx → JSX); the slot prefix keeps main and split editor on separate models, because a
 * model is disposed when its editor unmounts.
 */
function modelPath(slot: Slot, path: string): string {
  return `file:///${slot}/${path.split('/').map(encodeURIComponent).join('/')}`;
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
        showError(t('ide.autoSaveFailed', { name: baseName(path), message: errorMessage(error) }));
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
          showError(t('ide.saveFailed', { name: baseName(path), message: errorMessage(error) }));
        });
    },
    [cancelAutoSave, openDiff, save, showError, t],
  );

  // Ctrl/Cmd+S saves the focused editor's tab (capture phase: before the browser's own dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 's') return;
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

  const onMainMounted = useCallback(
    (editorInstance: CodeEditorInstance, path: string): void => {
      const target = { editor: editorInstance, path };
      mainEditor.current = target;
      editorInstance.onDidDispose(() => {
        if (mainEditor.current === target) mainEditor.current = null;
      });
      applyReveal(target);
    },
    [applyReveal],
  );

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
        showError(t('ide.saveFailed', { name: baseName(path), message: errorMessage(error) }));
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
      <CodeEditor
        key={`${slot}:${tab.path}`}
        tab={tab}
        slot={slot}
        readOnly={readOnly}
        onEdit={onEdit}
        onFocusPath={onFocusPath}
        onMounted={slot === 'main' ? onMainMounted : undefined}
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
            <DiffEditor
              theme={DEVGRIMOIRE_THEME}
              language={languageFromPath(diffTab.path)}
              original={diff.disk ?? ''}
              modified={diffTab.content}
              options={DIFF_OPTIONS}
            />
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
  onMounted?: (editor: CodeEditorInstance, path: string) => void;
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

/** One Monaco instance for one text tab; remounted (via `key`) when the tab changes. */
function CodeEditor({ tab, slot, readOnly, onEdit, onFocusPath, onMounted }: CodeEditorProps) {
  const { path, content, baseHash } = tab;
  const editorRef = useRef<CodeEditorInstance | null>(null);
  /** baseHash whose content the model's EOL was last matched against. */
  const eolSyncedFor = useRef<string | null | undefined>(undefined);
  const options = useMemo(
    () => ({ fontSize: 13, minimap: { enabled: false }, automaticLayout: true, tabSize: 2, readOnly }),
    [readOnly],
  );
  const onChange = useCallback((value: string | undefined) => onEdit(path, value ?? ''), [onEdit, path]);

  /*
   * A new disk version (reload, silent re-check) reaches the existing model as an edit, and
   * an edit is converted to the model's current EOL. If the file's EOL changed on disk, the
   * model would keep the old one and the next save would rewrite every line ending.
   * Keyed by baseHash so typing does not rescan the buffer.
   */
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || eolSyncedFor.current === baseHash) return;
    eolSyncedFor.current = baseHash;
    const eol = pureEol(content);
    const current =
      model.getEOL() === '\r\n' ? monacoEditor.EndOfLineSequence.CRLF : monacoEditor.EndOfLineSequence.LF;
    if (eol !== null && eol !== current) model.setEOL(eol);
  }, [baseHash, content]);

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
    eolSyncedFor.current = baseHash;
    // A new model detects the EOL from its content and keeps it (CRLF stays CRLF). Content
    // without any line break has nothing to detect — pin LF there instead of the OS default.
    const model = editorInstance.getModel();
    if (model && !/[\r\n]/.test(model.getValue())) model.setEOL(monacoEditor.EndOfLineSequence.LF);
    editorInstance.onDidFocusEditorText(() => onFocusPath(path));
    editorInstance.onDidDispose(() => {
      if (editorRef.current === editorInstance) editorRef.current = null;
    });
    onMounted?.(editorInstance, path);
  };

  return (
    <Editor
      path={modelPath(slot, path)}
      theme={DEVGRIMOIRE_THEME}
      language={languageFromPath(path)}
      value={content}
      onChange={onChange}
      onMount={onMount}
      options={options}
    />
  );
}
