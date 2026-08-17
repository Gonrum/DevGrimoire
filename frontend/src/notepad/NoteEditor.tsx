import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Archive as ArchiveIcon } from 'lucide-react';
import { notesApi } from './api';
import type { Note } from './types';

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface Props {
  note: Note;
  onLocalChange: (id: string, content: string) => void;
  onSaved: (note: Note) => void;
  onPromote: (note: Note) => void;
  onArchive: (id: string) => void;
}

const DEBOUNCE_MS = 500;
const SAVED_INDICATOR_MS = 1500;

export default function NoteEditor({ note, onLocalChange, onSaved, onPromote, onArchive }: Props) {
  const { t } = useTranslation();
  /*
   * `contentEdit === null` heisst: der Nutzer hat in diesem Editor noch nichts
   * getippt — dann gilt der Servertext. Vorher lag der Text in State und ein
   * Effect kopierte `note.content` hinein.
   *
   * Dieser Effect lief bei **jedem Tastendruck**: `onLocalChange` schreibt den
   * Zwischenstand in die Notizliste des Docks, `note.content` änderte sich und
   * der Effect setzte daraufhin `lastSavedRef.current` auf den *ungespeicherten*
   * Text und den Status zurück auf `idle`. Damit war die Bedingung
   * `status === 'dirty' && content !== lastSavedRef.current` nie erfüllt —
   * weder der Flush beim Tab-Wechsel noch der `sendBeacon` beim Schliessen der
   * Seite hat je ausgelöst, und der Status-Indikator sprang sofort auf leer.
   *
   * Ein Notizwechsel braucht hier keine Behandlung: `NotepadDock` rendert den
   * Editor mit `key={note._id}`, ein anderer Tab ist also ein neuer Mount.
   */
  const [contentEdit, setContentEdit] = useState<string | null>(null);
  const content = contentEdit ?? note.content;
  const [status, setStatus] = useState<SaveStatus>('idle');
  const lastSavedRef = useRef(note.content);
  const debounceRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const pendingFlushRef = useRef(false);

  const flush = async (value: string) => {
    if (inFlightRef.current) {
      pendingFlushRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setStatus('saving');
    try {
      const saved = await notesApi.update(note._id, { content: value });
      lastSavedRef.current = value;
      onSaved(saved);
      setStatus('saved');
      window.setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s));
      }, SAVED_INDICATOR_MS);
    } catch {
      setStatus('error');
    } finally {
      inFlightRef.current = false;
      if (pendingFlushRef.current) {
        pendingFlushRef.current = false;
        const latest = lastSavedRef.current;
        // Re-flush with the most recent local state.
        if (latest !== content) {
          void flush(content);
        }
      }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setContentEdit(value);
    onLocalChange(note._id, value);
    setStatus('dirty');
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void flush(value);
    }, DEBOUNCE_MS);
  };

  const handleRetry = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    void flush(content);
  };

  /*
   * Der Unload-/Unmount-Pfad darf sich **nicht** bei jeder Änderung neu
   * registrieren — sein Cleanup würde sonst bei jedem Tastendruck speichern.
   * Er liest den aktuellen Stand deshalb aus Refs statt aus der Closure.
   * (Vorher stand `[note._id]` mit abgeschaltetem `exhaustive-deps` im Array:
   * die Closure war die des ersten Renders, ein tatsächlich ausgelöster Flush
   * hätte den *Anfangstext* gespeichert.)
   */
  const pendingRef = useRef({ content, status });
  const flushRef = useRef(flush);
  useEffect(() => {
    pendingRef.current = { content, status };
    flushRef.current = flush;
  });

  useEffect(() => {
    const noteId = note._id;
    const hasUnsavedChanges = () =>
      pendingRef.current.status === 'dirty' &&
      pendingRef.current.content !== lastSavedRef.current;

    const beforeUnload = () => {
      if (!hasUnsavedChanges()) return;
      // Use sendBeacon for reliable flush on page close.
      try {
        const blob = new Blob([JSON.stringify({ content: pendingRef.current.content })], {
          type: 'application/json',
        });
        navigator.sendBeacon?.(`/api/notes/${noteId}`, blob);
      } catch {
        /* swallow */
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (hasUnsavedChanges()) {
        void flushRef.current(pendingRef.current.content);
      }
    };
  }, [note._id]);

  const statusLabel: Record<SaveStatus, string> = {
    idle: '',
    dirty: t('vermerke.statusDirty'),
    saving: t('vermerke.statusSaving'),
    saved: t('vermerke.statusSaved'),
    error: t('vermerke.statusError'),
  };

  const statusColor: Record<SaveStatus, string> = {
    idle: 'text-gray-500',
    dirty: 'text-amber-400',
    saving: 'text-blue-400',
    saved: 'text-green-400',
    error: 'text-red-400',
  };

  return (
    <div className="flex flex-col h-full">
      <textarea
        value={content}
        onChange={handleChange}
        spellCheck={false}
        className="flex-1 w-full bg-gray-900 text-gray-100 font-mono text-sm p-4 resize-none outline-none border-0 placeholder-gray-600"
        placeholder={t('vermerke.editorPlaceholder')}
      />
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-gray-800 bg-gray-950/50 text-xs gap-2">
        <span className={`${statusColor[status]} flex-1 truncate`}>
          {statusLabel[status] || ' '}
        </span>
        {status === 'error' && (
          <button
            type="button"
            onClick={handleRetry}
            className="text-red-400 hover:text-red-300 underline"
          >
            {t('vermerke.retry')}
          </button>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPromote(note)}
            className="flex items-center gap-1 text-amber-400 hover:text-amber-300 hover:bg-gray-800 px-2 py-1 rounded transition-colors"
            title={t('vermerke.promoteActionTooltip')}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('vermerke.promoteAction')}</span>
          </button>
          <button
            type="button"
            onClick={() => onArchive(note._id)}
            className="flex items-center gap-1 text-gray-400 hover:text-gray-200 hover:bg-gray-800 px-2 py-1 rounded transition-colors"
            title={t('vermerke.archiveActionTooltip')}
          >
            <ArchiveIcon className="w-3.5 h-3.5" />
            <span>{t('vermerke.archiveAction')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
