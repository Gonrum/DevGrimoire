import { useState } from 'react';
import { Todo, api } from '../api/client';

const COLUMNS: { key: Todo['status']; label: string; color: string }[] = [
  { key: 'open', label: 'Offen', color: 'border-gray-600' },
  { key: 'in_progress', label: 'In Arbeit', color: 'border-yellow-500' },
  { key: 'review', label: 'Review', color: 'border-purple-500' },
  { key: 'done', label: 'Erledigt', color: 'border-green-500' },
];

const PRIORITY_COLORS: Record<Todo['priority'], string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-gray-500',
};

const PRIORITY_LABELS: Record<Todo['priority'], string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

const STATUS_TRANSITIONS: Record<Todo['status'], { label: string; next: Todo['status'] }[]> = {
  open: [{ label: 'Starten', next: 'in_progress' }],
  in_progress: [
    { label: 'Zurück', next: 'open' },
    { label: 'Review', next: 'review' },
  ],
  review: [
    { label: 'Zurück', next: 'in_progress' },
    { label: 'Fertig', next: 'done' },
  ],
  done: [{ label: 'Wieder öffnen', next: 'open' }],
};

interface Props {
  todos: Todo[];
  projectId: string;
  onUpdate: () => void;
}

function TodoCreateForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.todos.create({
        projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status: 'open',
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setTitle('');
      setDescription('');
      setPriority('medium');
      setTags('');
      setOpen(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
      >
        + Neuer Task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <input
        type="text"
        placeholder="Titel *"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <textarea
        placeholder="Beschreibung (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
      />
      <div className="flex gap-3 items-center">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Todo['priority'])}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
        >
          <option value="low">Niedrig</option>
          <option value="medium">Mittel</option>
          <option value="high">Hoch</option>
          <option value="critical">Kritisch</option>
        </select>
        <input
          type="text"
          placeholder="Tags (kommagetrennt)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !title.trim()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
        >
          {saving ? 'Speichern...' : 'Erstellen'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
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
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="Beschreibung"
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
      />
      <div className="flex gap-2 items-center">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Todo['priority'])}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
        >
          <option value="low">Niedrig</option>
          <option value="medium">Mittel</option>
          <option value="high">Hoch</option>
          <option value="critical">Kritisch</option>
        </select>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Tags"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
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
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        {comments.length > 0 ? `${comments.length} Kommentar${comments.length > 1 ? 'e' : ''}` : 'Kommentieren'}
        {expanded ? ' ▴' : ' ▾'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {comments.map((c, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
              <div className="flex justify-between text-gray-500 mb-0.5">
                <span className={c.author === 'claude' ? 'text-blue-400' : 'text-gray-400'}>{c.author}</span>
                <span>{new Date(c.createdAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <p className="text-gray-300 whitespace-pre-wrap">{c.text}</p>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Kommentar schreiben..."
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving || !text.trim()}
              className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded disabled:opacity-50 transition-colors"
            >
              {saving ? '...' : 'Senden'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TodoCard({ todo, onUpdate }: { todo: Todo; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleStatusChange = async (newStatus: Todo['status']) => {
    await api.todos.update(todo._id, { status: newStatus });
    onUpdate();
  };

  const handleDelete = async () => {
    if (deleting) {
      await api.todos.delete(todo._id);
      onUpdate();
    } else {
      setDeleting(true);
    }
  };

  if (editing) {
    return (
      <div className="bg-gray-900 border border-blue-800 rounded-lg p-3">
        <TodoEditForm
          todo={todo}
          onSaved={() => { setEditing(false); onUpdate(); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 group">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium">{todo.title}</h4>
        <span className={`text-xs shrink-0 ${PRIORITY_COLORS[todo.priority]}`}>
          {PRIORITY_LABELS[todo.priority]}
        </span>
      </div>
      {todo.description && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-3">{todo.description}</p>
      )}
      {todo.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {todo.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}
      <TodoComments todo={todo} onUpdate={onUpdate} />
      <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {STATUS_TRANSITIONS[todo.status].map((tr) => (
          <button
            key={tr.next}
            type="button"
            onClick={() => handleStatusChange(tr.next)}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors"
          >
            {tr.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors"
        >
          Bearbeiten
        </button>
        <button
          type="button"
          onClick={handleDelete}
          onBlur={() => setDeleting(false)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ml-auto ${
            deleting
              ? 'bg-red-900 text-red-300 hover:bg-red-800'
              : 'bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-red-400'
          }`}
        >
          {deleting ? 'Sicher?' : 'Löschen'}
        </button>
      </div>
    </div>
  );
}

export default function TodoBoard({ todos, projectId, onUpdate }: Props) {
  return (
    <div>
      <TodoCreateForm projectId={projectId} onCreated={onUpdate} />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const items = todos.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className={`border-t-2 ${col.color} pt-3`}>
              <h3 className="text-sm font-medium text-gray-400 mb-3">
                {col.label}{' '}
                <span className="text-gray-600">({items.length})</span>
              </h3>
              <div className="space-y-2">
                {items.map((todo) => (
                  <TodoCard key={todo._id} todo={todo} onUpdate={onUpdate} />
                ))}
                {items.length === 0 && (
                  <p className="text-xs text-gray-700 italic">Keine Einträge</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
