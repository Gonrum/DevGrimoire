import { useState, useRef, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { Note } from './types';

interface Props {
  notes: Note[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onCreate: () => void;
}

export default function TabBar({
  notes,
  activeId,
  onSelect,
  onRename,
  onArchive,
  onReorder,
  onCreate,
}: Props) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const startRename = (note: Note) => {
    setEditingId(note._id);
    setEditingTitle(note.title);
  };

  const commitRename = () => {
    if (editingId && editingTitle.trim()) {
      onRename(editingId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
      setEditingTitle('');
    }
  };

  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (id: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  };

  const handleDragLeave = () => setDragOverId(null);

  const handleDrop = (targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    const sourceId = dragId.current;
    dragId.current = null;
    if (!sourceId || sourceId === targetId) return;
    const ids = notes.map((n) => n._id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  };

  const handleArchiveClick = (note: Note) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t('vermerke.archiveConfirm', { title: note.title }))) {
      onArchive(note._id);
    }
  };

  return (
    <div className="flex items-stretch border-b border-gray-800 bg-gray-900/50 overflow-x-auto">
      {notes.map((note) => {
        const isActive = note._id === activeId;
        const isEditing = editingId === note._id;
        const isDropTarget = dragOverId === note._id;
        return (
          <div
            key={note._id}
            draggable={!isEditing}
            onDragStart={handleDragStart(note._id)}
            onDragOver={handleDragOver(note._id)}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop(note._id)}
            onClick={() => onSelect(note._id)}
            className={`group flex items-center gap-1.5 px-3 py-2 border-r border-gray-800 cursor-pointer min-w-[120px] max-w-[200px] ${
              isActive
                ? 'bg-gray-800 text-gray-100'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
            } ${isDropTarget ? 'outline outline-1 outline-amber-500' : ''}`}
          >
            {note.isIdle && (
              <span
                className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0"
                title={t('vermerke.idleTooltip')}
              />
            )}
            {isEditing ? (
              <input
                autoFocus
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="bg-gray-700 text-gray-100 text-sm px-1 py-0.5 rounded outline-none min-w-0 flex-1"
              />
            ) : (
              <span
                className="text-sm truncate flex-1"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(note);
                }}
                title={note.title}
              >
                {note.title}
              </span>
            )}
            <button
              type="button"
              onClick={handleArchiveClick(note)}
              className="opacity-0 group-hover:opacity-100 hover:bg-gray-700 rounded p-0.5 flex-shrink-0"
              aria-label={t('vermerke.archiveTab')}
              title={t('vermerke.archiveTab')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onCreate}
        className="px-3 py-2 text-gray-400 hover:text-amber-400 hover:bg-gray-800/50 flex items-center justify-center flex-shrink-0"
        aria-label={t('vermerke.newNote')}
        title={t('vermerke.newNote')}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
