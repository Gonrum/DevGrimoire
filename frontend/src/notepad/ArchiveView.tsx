import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ExternalLink } from 'lucide-react';
import { useToast } from '../components/Toast';
import { notesApi } from './api';
import type { Note, PromotedRef } from './types';

interface Props {
  onClose: () => void;
  onRestoreRequest: () => void;
}

function entityLinkFor(ref: PromotedRef): string {
  switch (ref.entityType) {
    case 'knowledge':
      return ref.projectId
        ? `/projects/${ref.projectId}?tab=knowledge&knowledgeId=${ref.entityId}`
        : `/knowledge/${ref.entityId}`;
    case 'snippet':
      return ref.projectId
        ? `/projects/${ref.projectId}?tab=snippets&snippetId=${ref.entityId}`
        : `/snippets/${ref.entityId}`;
    case 'todo':
      return `/todos/${ref.entityId}`;
    case 'research':
      return ref.projectId
        ? `/projects/${ref.projectId}?tab=research&researchId=${ref.entityId}`
        : `/research/${ref.entityId}`;
    case 'manual':
      return ref.projectId
        ? `/projects/${ref.projectId}?tab=manual&manualId=${ref.entityId}`
        : `/manual/${ref.entityId}`;
    default:
      return '/';
  }
}

export default function ArchiveView({ onClose, onRestoreRequest }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [items, setItems] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await notesApi.listArchived());
    } catch {
      showError(t('vermerke.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [showError, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (note: Note) => {
    if (!window.confirm(t('vermerke.deleteConfirm', { title: note.title }))) return;
    try {
      await notesApi.remove(note._id);
      setItems((prev) => prev.filter((n) => n._id !== note._id));
      showSuccess(t('vermerke.deletedToast'));
      onRestoreRequest();
    } catch {
      showError(t('vermerke.errorDelete'));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3">
      {loading && items.length === 0 ? (
        <p className="text-sm text-gray-500 p-3">{t('vermerke.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500 p-3">{t('vermerke.archiveEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((note) => (
            <li
              key={note._id}
              className="bg-gray-800/50 border border-gray-800 rounded p-3 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-medium text-gray-200 truncate">
                    {note.title}
                  </h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {note.archivedAt
                      ? t('vermerke.archivedOn', {
                          date: new Date(note.archivedAt).toLocaleString(),
                        })
                      : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(note)}
                  className="text-gray-500 hover:text-red-400 p-1 rounded"
                  aria-label={t('vermerke.delete')}
                  title={t('vermerke.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {note.content && (
                <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap break-words max-h-20 overflow-hidden">
                  {note.content.slice(0, 200)}
                  {note.content.length > 200 ? '…' : ''}
                </pre>
              )}
              {note.promotedTo ? (
                <a
                  href={entityLinkFor(note.promotedTo)}
                  onClick={onClose}
                  className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 self-start"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('vermerke.promotedLink', {
                    type: t(`vermerke.entityType.${note.promotedTo.entityType}`),
                  })}
                </a>
              ) : (
                <span className="text-xs text-gray-600">{t('vermerke.justArchived')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
