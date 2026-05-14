import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notebook, Plus, X, Archive as ArchiveIcon, ArrowLeft } from 'lucide-react';
import { useToast } from '../components/Toast';
import { notesApi } from './api';
import type { Note } from './types';
import TabBar from './TabBar';
import NoteEditor from './NoteEditor';
import ArchiveView from './ArchiveView';
import IdleModal from './IdleModal';
import PromotionDialog from './PromotionDialog';

type View = 'active' | 'archive';

const DOCK_WIDTH_KEY = 'devgrimoire_notepad_dock_width';
const DOCK_DEFAULT_WIDTH = 600;
const DOCK_MIN_WIDTH = 360;

function loadDockWidth(): number {
  if (typeof window === 'undefined') return DOCK_DEFAULT_WIDTH;
  const stored = localStorage.getItem(DOCK_WIDTH_KEY);
  const n = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n >= DOCK_MIN_WIDTH ? n : DOCK_DEFAULT_WIDTH;
}

export default function NotepadDock() {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('active');
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [idleNote, setIdleNote] = useState<Note | null>(null);
  const [promotionTarget, setPromotionTarget] = useState<Note | null>(null);

  const [dockWidth, setDockWidth] = useState<number>(loadDockWidth);
  const [resizing, setResizing] = useState(false);

  const idleShownThisOpenRef = useRef(false);

  // Resize handle drag (sm+ only — mobile stays full-width)
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const vw = window.innerWidth;
      const max = Math.floor(vw * 0.8);
      // Panel is anchored to the left edge → new width = cursor X.
      const next = Math.min(Math.max(e.clientX, DOCK_MIN_WIDTH), max);
      setDockWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  // Persist width once a drag commits.
  useEffect(() => {
    if (resizing) return;
    localStorage.setItem(DOCK_WIDTH_KEY, String(dockWidth));
  }, [dockWidth, resizing]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
  };

  const resetWidth = () => {
    setDockWidth(DOCK_DEFAULT_WIDTH);
  };

  // Load active notes whenever the overlay opens (or after mutations).
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await notesApi.list();
      setNotes(list);
      // If active tab disappeared (e.g. archived in another window), reset.
      setActiveId((prev) => {
        if (prev && list.some((n) => n._id === prev)) return prev;
        return list.length > 0
          ? [...list].sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            )[0]._id
          : null;
      });
      return list;
    } catch (err) {
      showError(t('vermerke.errorLoad'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [showError, t]);

  useEffect(() => {
    if (!open) {
      idleShownThisOpenRef.current = false;
      return;
    }
    void refresh().then((list) => {
      if (idleShownThisOpenRef.current) return;
      const idle = list.find((n) => n.isIdle);
      if (idle) {
        idleShownThisOpenRef.current = true;
        setIdleNote(idle);
      }
    });
  }, [open, refresh]);

  const activeNote = useMemo(
    () => notes.find((n) => n._id === activeId) ?? null,
    [notes, activeId],
  );

  // --- Mutations ---

  const handleCreate = useCallback(async () => {
    try {
      const note = await notesApi.create();
      setNotes((prev) => [...prev, note]);
      setActiveId(note._id);
    } catch {
      showError(t('vermerke.errorCreate'));
    }
  }, [showError, t]);

  const handleRename = useCallback(
    async (id: string, title: string) => {
      try {
        const updated = await notesApi.update(id, { title });
        setNotes((prev) => prev.map((n) => (n._id === id ? updated : n)));
      } catch {
        showError(t('vermerke.errorSave'));
      }
    },
    [showError, t],
  );

  const handleArchive = useCallback(
    async (id: string) => {
      try {
        await notesApi.archive(id);
        setNotes((prev) => prev.filter((n) => n._id !== id));
        if (activeId === id) setActiveId(null);
      } catch {
        showError(t('vermerke.errorArchive'));
      }
    },
    [activeId, showError, t],
  );

  const handleReorder = useCallback(
    async (orderedIds: string[]) => {
      // Optimistic: reorder local state immediately.
      setNotes((prev) => {
        const map = new Map(prev.map((n) => [n._id, n]));
        return orderedIds.map((id) => map.get(id)).filter(Boolean) as Note[];
      });
      try {
        await notesApi.reorder(orderedIds);
      } catch {
        showError(t('vermerke.errorReorder'));
        void refresh();
      }
    },
    [refresh, showError, t],
  );

  const handleContentChange = useCallback(
    (id: string, content: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n._id === id
            ? { ...n, content, updatedAt: new Date().toISOString() }
            : n,
        ),
      );
    },
    [],
  );

  const handleNoteSaved = useCallback(
    (saved: Note) => {
      setNotes((prev) => prev.map((n) => (n._id === saved._id ? saved : n)));
    },
    [],
  );

  // --- Idle-modal actions ---

  const handleIdleArchive = useCallback(async () => {
    if (!idleNote) return;
    await handleArchive(idleNote._id);
    setIdleNote(null);
    showSuccess(t('vermerke.archivedToast'));
  }, [handleArchive, idleNote, showSuccess, t]);

  const handleIdleSnooze = useCallback(async () => {
    if (!idleNote) return;
    try {
      const updated = await notesApi.snooze(idleNote._id);
      setNotes((prev) => prev.map((n) => (n._id === updated._id ? updated : n)));
    } catch {
      showError(t('vermerke.errorSnooze'));
    } finally {
      setIdleNote(null);
    }
  }, [idleNote, showError, t]);

  const handleIdlePromote = useCallback(() => {
    if (!idleNote) return;
    setPromotionTarget(idleNote);
    setIdleNote(null);
  }, [idleNote]);

  // --- Promotion ---

  const handlePromotionDone = useCallback(
    (result: { entityLink: string }) => {
      if (!promotionTarget) return;
      // Note is archived server-side; remove from active list locally.
      setNotes((prev) => prev.filter((n) => n._id !== promotionTarget._id));
      if (activeId === promotionTarget._id) setActiveId(null);
      setPromotionTarget(null);
      showSuccess(t('vermerke.promotedToast'));
      // entityLink is exposed via the Archive view; we don't auto-navigate.
      void result;
    },
    [activeId, promotionTarget, showSuccess, t],
  );

  return (
    <>
      {/* Floating button — bottom-left, separate from ChatDock (bottom-right) */}
      {!open && (
        <button
          type="button"
          aria-label={t('vermerke.openButton')}
          onClick={() => setOpen(true)}
          className="fixed bottom-6 left-6 z-50 bg-amber-700 hover:bg-amber-600 text-white rounded-full shadow-lg shadow-amber-900/40 p-3 transition-transform hover:scale-105"
          title={t('vermerke.openButton')}
        >
          <Notebook className="w-5 h-5" />
        </button>
      )}

      {/* Slide-in panel from the left */}
      {open && (
        <div
          className="fixed top-0 left-0 z-50 h-full w-full bg-gray-900 border-r border-gray-800 shadow-2xl flex flex-col sm:w-[var(--dock-w)]"
          style={{ ['--dock-w' as any]: `${dockWidth}px` }}
        >
          {/* Resize handle on the right edge (sm+ only) */}
          <div
            className="hidden sm:block absolute top-0 right-0 h-full w-1.5 cursor-col-resize group hover:bg-amber-600/30 z-10"
            onMouseDown={startResize}
            onDoubleClick={resetWidth}
            title={t('vermerke.resizeHandle')}
          >
            <div className="absolute inset-y-0 right-0 w-px bg-gray-800 group-hover:bg-amber-600 transition-colors" />
          </div>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <Notebook className="w-5 h-5 text-amber-400" />
              <h2 className="text-base font-semibold text-gray-100">
                {t('vermerke.title')}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              {view === 'archive' ? (
                <button
                  type="button"
                  onClick={() => setView('active')}
                  className="text-sm text-gray-400 hover:text-gray-200 px-2 py-1 rounded flex items-center gap-1"
                  title={t('vermerke.backToActive')}
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t('vermerke.backToActive')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setView('archive')}
                  className="text-sm text-gray-400 hover:text-gray-200 px-2 py-1 rounded flex items-center gap-1"
                  title={t('vermerke.showArchive')}
                >
                  <ArchiveIcon className="w-4 h-4" />
                  {t('vermerke.showArchive')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-200 p-1 rounded"
                aria-label={t('vermerke.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          {view === 'active' ? (
            <>
              <TabBar
                notes={notes}
                activeId={activeId}
                onSelect={setActiveId}
                onRename={handleRename}
                onArchive={handleArchive}
                onReorder={handleReorder}
                onCreate={handleCreate}
              />
              <div className="flex-1 overflow-hidden">
                {loading && notes.length === 0 ? (
                  <div className="p-6 text-sm text-gray-500">{t('vermerke.loading')}</div>
                ) : notes.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
                    <Notebook className="w-12 h-12 text-gray-700" />
                    <p className="text-sm text-gray-400">{t('vermerke.empty')}</p>
                    <button
                      type="button"
                      onClick={handleCreate}
                      className="bg-amber-700 hover:bg-amber-600 text-white text-sm px-3 py-1.5 rounded flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" />
                      {t('vermerke.newNote')}
                    </button>
                  </div>
                ) : activeNote ? (
                  <NoteEditor
                    key={activeNote._id}
                    note={activeNote}
                    onLocalChange={handleContentChange}
                    onSaved={handleNoteSaved}
                  />
                ) : (
                  <div className="p-6 text-sm text-gray-500">
                    {t('vermerke.selectTab')}
                  </div>
                )}
              </div>
            </>
          ) : (
            <ArchiveView
              onClose={() => setView('active')}
              onRestoreRequest={() => void refresh()}
            />
          )}
        </div>
      )}

      {/* Idle modal — shown once per overlay-open if there's an idle note */}
      {idleNote && (
        <IdleModal
          note={idleNote}
          onPromote={handleIdlePromote}
          onArchive={handleIdleArchive}
          onSnooze={handleIdleSnooze}
        />
      )}

      {/* Promotion dialog */}
      {promotionTarget && (
        <PromotionDialog
          note={promotionTarget}
          onCancel={() => setPromotionTarget(null)}
          onDone={handlePromotionDone}
        />
      )}
    </>
  );
}
