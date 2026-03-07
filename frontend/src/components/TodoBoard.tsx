import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Todo, Milestone, api } from '../api/client';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import {
  COLUMNS, PRIORITY_COLORS, PRIORITY_LABELS,
  STATUS_COLORS, STATUS_LABELS, STATUS_TRANSITIONS,
} from './todo-utils';
import { useToast } from './Toast';

interface Props {
  todos: Todo[];
  milestones: Milestone[];
  projectId: string;
  onUpdate: () => void;
}

type SortKey = 'updated' | 'created' | 'priority' | 'title';
type SortDir = 'asc' | 'desc';

const PRIORITY_ORDER: Record<Todo['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortTodos(todos: Todo[], sortKey: SortKey, sortDir: SortDir): Todo[] {
  const sorted = [...todos].sort((a, b) => {
    switch (sortKey) {
      case 'priority': return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      case 'title': return a.title.localeCompare(b.title, 'de');
      case 'created': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'updated':
      default: return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
  });
  return sortDir === 'asc' ? sorted : sorted.reverse();
}

function TodoEditForm({ todo, onSaved, onCancel }: { todo: Todo; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description || '');
  const [priority, setPriority] = useState(todo.priority);
  const [tags, setTags] = useState(todo.tags.join(', '));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.todos.update(todo._id, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500" autoFocus />
      <MarkdownEditor value={description} onChange={setDescription} rows={2} placeholder="Beschreibung (Markdown)" />
      <div className="flex gap-2 items-center">
        <select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500">
          <option value="low">Niedrig</option>
          <option value="medium">Mittel</option>
          <option value="high">Hoch</option>
          <option value="critical">Kritisch</option>
        </select>
        <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !title.trim()} className="text-xs px-2 py-0.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors">
          {saving ? '...' : 'Speichern'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors">
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function TodoComments({ todo, onUpdate }: { todo: Todo; onUpdate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await api.todos.addComment(todo._id, text.trim());
      setText('');
      onUpdate();
    } finally {
      setSaving(false);
    }
  };

  const comments = todo.comments || [];

  return (
    <div className="mt-2" onClick={(e) => e.preventDefault()}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        {comments.length > 0 ? `${comments.length} Kommentar${comments.length > 1 ? 'e' : ''}` : 'Kommentieren'}
        {expanded ? ' \u25B4' : ' \u25BE'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {comments.map((c, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
              <div className="flex justify-between text-gray-500 mb-0.5">
                <span className={c.author === 'claude' ? 'text-blue-400' : 'text-gray-400'}>{c.author}</span>
                <span>{new Date(c.createdAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <Markdown className="text-gray-300">{c.text}</Markdown>
            </div>
          ))}
          <div className="flex gap-2">
            <input type="text" value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Kommentar schreiben..." onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              aria-label="Kommentar schreiben"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            <button type="button" onClick={handleAdd} disabled={saving || !text.trim()}
              className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded disabled:opacity-50 transition-colors">
              {saving ? '...' : 'Senden'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TodoCard({ todo, allTodos, projectId, onUpdate, onDragStart, showError }: { todo: Todo; allTodos: Todo[]; projectId: string; onUpdate: () => void; onDragStart?: (todoId: string) => void; showError: (msg: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const hasBlockers = (todo.blockedBy || []).some((bid) => {
    const blocker = allTodos.find((t) => t._id === bid);
    return blocker && blocker.status !== 'done';
  });

  const handleStatusChange = async (newStatus: Todo['status']) => {
    try {
      await api.todos.update(todo._id, { status: newStatus });
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Status-Änderung fehlgeschlagen');
    }
  };

  const handleDelete = async () => {
    if (deleting) {
      try {
        await api.todos.delete(todo._id);
        onUpdate();
      } catch (err: any) {
        showError(err.message || 'Löschen fehlgeschlagen');
      }
    } else {
      setDeleting(true);
    }
  };

  const handleArchiveToggle = async () => {
    try {
      await api.todos.update(todo._id, { archived: !todo.archived } as Partial<Todo>);
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Archivierung fehlgeschlagen');
    }
  };

  if (editing) {
    return (
      <div className="bg-gray-900 border border-blue-800 rounded-lg p-3">
        <TodoEditForm todo={todo} onSaved={() => { setEditing(false); onUpdate(); }} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <Link to={`/projects/${projectId}/todos/${todo._id}`}
      draggable
      aria-roledescription="Verschiebbare Aufgabe"
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(todo._id); }}
      onDragEnd={() => onDragStart?.('')}
      className="block bg-gray-900 border border-gray-800 rounded-lg p-3 group hover:border-gray-700 transition-colors cursor-grab active:cursor-grabbing">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium">
          {hasBlockers && <span className="text-red-400 mr-1" title="Blockiert">&#x26D4;</span>}
          {todo.title}
        </h4>
        <span className={`text-xs shrink-0 ${PRIORITY_COLORS[todo.priority]}`}>
          {PRIORITY_LABELS[todo.priority]}
        </span>
      </div>
      {todo.description && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-3">{todo.description}</p>
      )}
      <p className="text-xs text-gray-600 mt-1">
        {new Date(todo.createdAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}
        {todo.updatedAt !== todo.createdAt && (
          <span> · bearbeitet {new Date(todo.updatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
        )}
      </p>
      {todo.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {todo.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}
      <TodoComments todo={todo} onUpdate={onUpdate} />
      <div className="flex flex-wrap items-center gap-2 mt-2 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" onClick={(e) => e.preventDefault()}>
        {STATUS_TRANSITIONS[todo.status].map((tr) => (
          <button key={tr.next} type="button" onClick={() => handleStatusChange(tr.next)}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
            {tr.label}
          </button>
        ))}
        <button type="button" onClick={() => setEditing(true)}
          className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
          Bearbeiten
        </button>
        <button type="button" onClick={handleArchiveToggle}
          className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
          {todo.archived ? 'Wiederherstellen' : 'Archivieren'}
        </button>
        <button type="button" onClick={handleDelete} onBlur={() => setDeleting(false)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ml-auto ${deleting ? 'bg-red-900 text-red-300 hover:bg-red-800' : 'bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-red-400'}`}>
          {deleting ? 'Sicher?' : 'Löschen'}
        </button>
      </div>
    </Link>
  );
}

function TodoListRow({ todo, projectId, onUpdate, showError }: { todo: Todo; projectId: string; onUpdate: () => void; showError: (msg: string) => void }) {
  const handleStatusChange = async (e: React.MouseEvent, newStatus: Todo['status']) => {
    e.preventDefault();
    try {
      await api.todos.update(todo._id, { status: newStatus });
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Status-Änderung fehlgeschlagen');
    }
  };

  const comments = todo.comments || [];

  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors">
      <td className="py-2.5 px-3">
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[todo.status]}`}>
          {STATUS_LABELS[todo.status]}
        </span>
      </td>
      <td className="py-2.5 px-3">
        <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>
          {PRIORITY_LABELS[todo.priority]}
        </span>
      </td>
      <td className="py-2.5 px-3">
        <Link to={`/projects/${projectId}/todos/${todo._id}`} className="hover:text-blue-400 transition-colors">
          <div className="text-sm">{todo.title}</div>
          {todo.description && <div className="text-xs text-gray-600 line-clamp-1 mt-0.5">{todo.description}</div>}
        </Link>
      </td>
      <td className="py-2.5 px-3">
        <div className="flex flex-wrap gap-1">
          {todo.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      </td>
      <td className="py-2.5 px-3 text-xs text-gray-600">
        {comments.length > 0 && <span>{comments.length}</span>}
      </td>
      <td className="py-2.5 px-3 text-xs text-gray-600 whitespace-nowrap">
        {new Date(todo.updatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex gap-1">
          {STATUS_TRANSITIONS[todo.status].map((tr) => (
            <button key={tr.next} type="button" onClick={(e) => handleStatusChange(e, tr.next)}
              className="text-xs px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-gray-200 rounded transition-colors">
              {tr.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

type ViewMode = 'kanban' | 'list';

export default function TodoBoard({ todos, milestones, projectId, onUpdate }: Props) {
  const { showError } = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [filterMilestone, setFilterMilestone] = useState<string>('');
  const [filterTag, setFilterTag] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [dragTodoId, setDragTodoId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const now = Date.now();
  const isArchived = (t: Todo) =>
    t.archived || (t.status === 'done' && now - new Date(t.updatedAt).getTime() > 24 * 60 * 60 * 1000);
  const archivedCount = useMemo(() => todos.filter(isArchived).length, [todos]);
  const archivableDone = useMemo(() => todos.filter((t) => t.status === 'done' && !t.archived), [todos]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    todos.forEach((t) => t.tags.forEach((tag) => set.add(tag)));
    return Array.from(set).sort();
  }, [todos]);

  const filtered = useMemo(() => {
    let result = todos;
    if (!showArchived) {
      result = result.filter((t) => !isArchived(t));
    }
    if (filterStatus) result = result.filter((t) => t.status === filterStatus);
    if (filterPriority) result = result.filter((t) => t.priority === filterPriority);
    if (filterMilestone === '_none') result = result.filter((t) => !t.milestoneId);
    else if (filterMilestone) result = result.filter((t) => t.milestoneId === filterMilestone);
    if (filterTag) result = result.filter((t) => t.tags.includes(filterTag));
    return sortTodos(result, sortKey, sortDir);
  }, [todos, showArchived, filterStatus, filterPriority, filterMilestone, filterTag, sortKey, sortDir]);

  const hasFilters = filterStatus || filterPriority || filterMilestone || filterTag;

  const clearFilters = () => {
    setFilterStatus('');
    setFilterPriority('');
    setFilterMilestone('');
    setFilterTag('');
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Link to={`/projects/${projectId}/todos/new`}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Neuer Task
        </Link>
        <div className="flex bg-gray-800 rounded-lg p-0.5 ml-auto">
          <button type="button" onClick={() => setViewMode('kanban')}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${viewMode === 'kanban' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
            Kanban
          </button>
          <button type="button" onClick={() => setViewMode('list')}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${viewMode === 'list' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
            Liste
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="Status filtern"
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
          <option value="">Alle Status</option>
          {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} aria-label="Priorität filtern"
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
          <option value="">Alle Prioritäten</option>
          <option value="critical">Kritisch</option>
          <option value="high">Hoch</option>
          <option value="medium">Mittel</option>
          <option value="low">Niedrig</option>
        </select>
        {milestones.length > 0 && (
          <select value={filterMilestone} onChange={(e) => setFilterMilestone(e.target.value)} aria-label="Milestone filtern"
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            <option value="">Alle Milestones</option>
            <option value="_none">Ohne Milestone</option>
            {milestones.map((ms) => <option key={ms._id} value={ms._id}>{ms.name}</option>)}
          </select>
        )}
        {allTags.length > 0 && (
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} aria-label="Tag filtern"
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            <option value="">Alle Tags</option>
            {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        )}
        <div className="flex items-center gap-1 sm:ml-auto w-full sm:w-auto">
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sortierung"
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            <option value="updated">Aktualisiert</option>
            <option value="created">Erstellt</option>
            <option value="priority">Priorität</option>
            <option value="title">Titel</option>
          </select>
          <button type="button" onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
            className="text-xs px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200 transition-colors"
            title={sortDir === 'asc' ? 'Aufsteigend' : 'Absteigend'}>
            {sortDir === 'asc' ? '\u2191' : '\u2193'}
          </button>
        </div>
        {hasFilters && (
          <button type="button" onClick={clearFilters}
            className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300 transition-colors">
            Filter zurücksetzen
          </button>
        )}
        {archivableDone.length > 0 && (
          <button type="button" onBlur={() => setConfirmArchiveAll(false)} onClick={async () => {
            if (!confirmArchiveAll) { setConfirmArchiveAll(true); return; }
            setConfirmArchiveAll(false);
            try {
              await Promise.all(archivableDone.map((t) => api.todos.update(t._id, { archived: true } as Partial<Todo>)));
              onUpdate();
            } catch (err: any) {
              showError(err.message || 'Archivierung fehlgeschlagen');
            }
          }}
            className={`text-xs px-2 py-1 rounded transition-colors ${confirmArchiveAll ? 'bg-yellow-900/60 text-yellow-300' : 'text-gray-600 hover:text-gray-400'}`}>
            {confirmArchiveAll ? `Sicher? (${archivableDone.length} Tasks)` : `Erledigte archivieren (${archivableDone.length})`}
          </button>
        )}
        {archivedCount > 0 && (
          <button type="button" onClick={() => setShowArchived(!showArchived)}
            className={`text-xs px-2 py-1 rounded transition-colors ${showArchived ? 'bg-gray-700 text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}>
            {showArchived ? `Archiv ausblenden (${archivedCount})` : `Archiv (${archivedCount})`}
          </button>
        )}
      </div>

      {hasFilters && (
        <p className="text-xs text-gray-600 mb-3">{filtered.length} von {todos.length} Tasks</p>
      )}

      {viewMode === 'kanban' ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4" role="region" aria-label="Kanban Board">
          {COLUMNS.map((col) => {
            const items = filtered.filter((t) => t.status === col.key);
            const dragSource = dragTodoId ? todos.find((t) => t._id === dragTodoId) : null;
            const isOver = dragOverCol === col.key && dragTodoId;
            const isValidDrop = dragSource && STATUS_TRANSITIONS[dragSource.status].some((tr) => tr.next === col.key);
            return (
              <div key={col.key}
                className={`border-t-2 ${isOver ? (isValidDrop ? 'border-blue-500 bg-blue-900/10' : 'border-red-500/50 bg-red-900/5') : col.color} pt-3 rounded-b-lg transition-colors`}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverCol(col.key); }}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  if (!dragTodoId) return;
                  const todo = todos.find((t) => t._id === dragTodoId);
                  if (!todo || todo.status === col.key) { setDragTodoId(null); return; }
                  const allowed = STATUS_TRANSITIONS[todo.status].map((tr) => tr.next);
                  if (!allowed.includes(col.key)) { setDragTodoId(null); return; }
                  setDragTodoId(null);
                  try {
                    await api.todos.update(dragTodoId, { status: col.key as Todo['status'] });
                    onUpdate();
                  } catch (err: any) {
                    showError(err.message || 'Status-Änderung fehlgeschlagen');
                  }
                }}>
                <h3 className="text-sm font-medium text-gray-400 mb-3">
                  {col.label}{' '}
                  <span className="text-gray-600">({items.length})</span>
                </h3>
                <div className="space-y-2 min-h-[2rem]" role="list" aria-label={col.label}>
                  {items.map((todo) => (
                    <TodoCard key={todo._id} todo={todo} allTodos={todos} projectId={projectId} onUpdate={onUpdate}
                      onDragStart={(id) => setDragTodoId(id || null)} showError={showError} />
                  ))}
                  {items.length === 0 && !isOver && (
                    <p className="text-xs text-gray-700 italic">Keine Einträge</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500">
                <th className="py-2 px-3 font-medium">Status</th>
                <th className="py-2 px-3 font-medium">Priorität</th>
                <th className="py-2 px-3 font-medium">Titel</th>
                <th className="py-2 px-3 font-medium">Tags</th>
                <th className="py-2 px-3 font-medium" title="Kommentare">Komm.</th>
                <th className="py-2 px-3 font-medium">Aktualisiert</th>
                <th className="py-2 px-3 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="py-4 text-center text-xs text-gray-700 italic">Keine Tasks vorhanden</td></tr>
              )}
              {filtered.map((todo) => (
                <TodoListRow key={todo._id} todo={todo} projectId={projectId} onUpdate={onUpdate} showError={showError} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
