import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Archive as ArchiveIcon, Clock } from 'lucide-react';
import type { Note } from './types';

interface Props {
  note: Note;
  onPromote: () => void;
  onArchive: () => void;
  onSnooze: () => void;
}

export default function IdleModal({ note, onPromote, onArchive, onSnooze }: Props) {
  const { t } = useTranslation();

  // Esc = snooze (safe default — never destroys data).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSnooze();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSnooze]);

  // Die Uhr einmal beim Öffnen lesen statt bei jedem Render: `Date.now()` im
  // Render ist unrein (`react-hooks/purity`), und die Angabe "seit N Tagen"
  // ändert sich in der Lebensdauer des Modals ohnehin nicht.
  const [openedAt] = useState(() => Date.now());

  const daysIdle = useMemo(() => {
    const ms = openedAt - new Date(note.updatedAt).getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }, [note.updatedAt, openedAt]);

  const preview = note.content.slice(0, 200) + (note.content.length > 200 ? '…' : '');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg shadow-2xl max-w-md w-full overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-gray-100">
            {t('vermerke.idleTitle', { title: note.title })}
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            {t('vermerke.idleDescription', { days: daysIdle })}
          </p>
        </div>
        <div className="px-5 py-3 max-h-40 overflow-y-auto border-b border-gray-800">
          <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">
            {preview || t('vermerke.emptyPreview')}
          </pre>
        </div>
        <div className="p-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={onPromote}
            className="w-full bg-amber-700 hover:bg-amber-600 text-white text-sm px-4 py-2 rounded flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            {t('vermerke.idlePromote')}
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm px-4 py-2 rounded flex items-center justify-center gap-2"
          >
            <ArchiveIcon className="w-4 h-4" />
            {t('vermerke.idleArchive')}
          </button>
          <button
            type="button"
            onClick={onSnooze}
            className="w-full text-gray-400 hover:text-gray-200 text-sm px-4 py-2 rounded flex items-center justify-center gap-2"
          >
            <Clock className="w-4 h-4" />
            {t('vermerke.idleSnooze')}
          </button>
        </div>
      </div>
    </div>
  );
}
