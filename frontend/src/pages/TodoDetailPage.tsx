import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, Todo, Milestone } from '../api/client';
import {
  PRIORITY_COLORS, PRIORITY_LABELS,
  STATUS_COLORS, STATUS_LABELS, STATUS_TRANSITIONS, TRANSITION_BUTTON_COLORS,
} from '../components/todo-utils';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmButton from '../components/ui/ConfirmButton';
import { LoadingText } from '../components/ui/LoadingSpinner';

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
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Titel</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500" autoFocus />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
        <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder="Beschreibung (Markdown)" />
      </div>
      <div className="flex gap-3 items-center">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Priorität</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
            <option value="low">Niedrig</option>
            <option value="medium">Mittel</option>
            <option value="high">Hoch</option>
            <option value="critical">Kritisch</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Tags</label>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="kommagetrennt"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? 'Speichern...' : 'Speichern'}
        </Button>
        <Button type="button" onClick={onCancel}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

export default function TodoDetailPage() {
  const { id, todoId } = useParams<{ id: string; todoId: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [todo, setTodo] = useState<Todo | null>(null);
  const [allTodos, setAllTodos] = useState<Todo[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const loadTodo = () => {
    if (!todoId) return;
    api.todos.get(todoId)
      .then(setTodo)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadTodo(); }, [todoId]);
  useEffect(() => {
    if (id) {
      api.milestones.list(id).then(setMilestones);
      api.todos.list({ projectId: id }).then(setAllTodos);
    }
  }, [id]);

  const handleStatusChange = async (newStatus: Todo['status']) => {
    if (!todoId) return;
    try {
      await api.todos.update(todoId, { status: newStatus });
      loadTodo();
    } catch (err: any) {
      showError(err.message || 'Status-Änderung fehlgeschlagen');
    }
  };

  const handleAddComment = async () => {
    if (!todoId || !commentText.trim()) return;
    setSavingComment(true);
    try {
      await api.todos.addComment(todoId, commentText.trim());
      setCommentText('');
      loadTodo();
    } finally {
      setSavingComment(false);
    }
  };

  if (loading) return <LoadingText />;
  if (error || !todo) {
    return (
      <div>
        <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">&larr; Zurück zum Projekt</Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">{error || 'Task nicht gefunden.'}</p>
        </div>
      </div>
    );
  }

  const comments = todo.comments || [];

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      {editing ? (
        <div className="max-w-3xl mx-auto">
          <h2 className="text-lg font-semibold mb-4">Task bearbeiten</h2>
          <TodoEditForm todo={todo} onSaved={() => { setEditing(false); loadTodo(); }} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <div className="max-w-3xl mx-auto">
          <h1 className="text-xl font-bold mb-3">{todo.title}</h1>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Badge color={STATUS_COLORS[todo.status]} rounded="full">
              {STATUS_LABELS[todo.status]}
            </Badge>
            <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>
              {PRIORITY_LABELS[todo.priority]}
            </span>
          </div>

          {todo.description && (
            <Markdown className="text-gray-400 mb-4">{todo.description}</Markdown>
          )}

          {todo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-4">
              {todo.tags.map((tag) => (
                <Badge key={tag} color="bg-gray-800 text-gray-400">{tag}</Badge>
              ))}
            </div>
          )}

          {milestones.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs text-gray-600 mb-1">Milestone</label>
              <select
                value={todo.milestoneId || ''}
                onChange={async (e) => {
                  try {
                    await api.todos.update(todo._id, { milestoneId: e.target.value || undefined } as Partial<Todo>);
                    loadTodo();
                  } catch (err: any) {
                    showError(err.message || 'Milestone-Änderung fehlgeschlagen');
                  }
                }}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
              >
                <option value="">Kein Milestone</option>
                {milestones.map((ms) => (
                  <option key={ms._id} value={ms._id}>{ms.name}</option>
                ))}
              </select>
            </div>
          )}

          {(() => {
            const blockedBy = (todo.blockedBy || [])
              .map((bid) => allTodos.find((t) => t._id === bid))
              .filter(Boolean) as Todo[];
            const blocks = allTodos.filter((t) => (t.blockedBy || []).includes(todo._id));
            const availableDeps = allTodos.filter((t) => t._id !== todo._id && !(todo.blockedBy || []).includes(t._id));
            const hasBlockers = blockedBy.some((b) => b.status !== 'done');

            return (
              <div className="mb-4 space-y-2">
                {hasBlockers && (
                  <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-900/20 border border-red-900/50 rounded px-2 py-1.5">
                    <span>Blockiert</span>
                  </div>
                )}
                {blockedBy.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Blockiert von</label>
                    <div className="space-y-1">
                      {blockedBy.map((dep) => (
                        <div key={dep._id} className="flex items-center gap-2 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dep.status === 'done' ? 'bg-green-500' : dep.status === 'in_progress' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
                          <Link to={`/projects/${id}/todos/${dep._id}`} className="text-gray-400 hover:text-blue-400 transition-colors">
                            <span className={dep.status === 'done' ? 'line-through text-gray-600' : ''}>{dep.title}</span>
                          </Link>
                          <button type="button" onClick={async () => {
                            try {
                              await api.todos.update(todo._id, { blockedBy: (todo.blockedBy || []).filter((b) => b !== dep._id) } as Partial<Todo>);
                              loadTodo();
                            } catch (err: any) {
                              showError(err.message || 'Abhängigkeit entfernen fehlgeschlagen');
                            }
                          }} className="text-gray-600 hover:text-red-400 transition-colors ml-auto">&times;</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {blocks.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Blockiert</label>
                    <div className="space-y-1">
                      {blocks.map((dep) => (
                        <div key={dep._id} className="flex items-center gap-2 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dep.status === 'done' ? 'bg-green-500' : dep.status === 'in_progress' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
                          <Link to={`/projects/${id}/todos/${dep._id}`} className="text-gray-400 hover:text-blue-400 transition-colors">
                            {dep.title}
                          </Link>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {availableDeps.length > 0 && (
                  <select
                    value=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      try {
                        await api.todos.update(todo._id, { blockedBy: [...(todo.blockedBy || []), e.target.value] } as Partial<Todo>);
                        loadTodo();
                      } catch (err: any) {
                        showError(err.message || 'Abhängigkeit hinzufügen fehlgeschlagen');
                      }
                    }}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">+ Abhängigkeit hinzufügen...</option>
                    {availableDeps.map((t) => (
                      <option key={t._id} value={t._id}>{t.title}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })()}

          <div className="text-xs text-gray-600 mb-5 space-y-0.5">
            <p>Erstellt: {new Date(todo.createdAt).toLocaleString('de-DE')}</p>
            {todo.updatedAt !== todo.createdAt && (
              <p>Aktualisiert: {new Date(todo.updatedAt).toLocaleString('de-DE')}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-8">
            {STATUS_TRANSITIONS[todo.status].map((tr) => (
              <Button key={tr.next} type="button" variant="none" size="sm" onClick={() => handleStatusChange(tr.next)}
                className={TRANSITION_BUTTON_COLORS[tr.next]}>
                {tr.label}
              </Button>
            ))}
            <Button type="button" variant="none" size="sm" className="bg-blue-900/60 hover:bg-blue-900 text-blue-300" onClick={() => setEditing(true)}>
              Bearbeiten
            </Button>
            <Button type="button" variant="none" size="sm" className="bg-gray-700 hover:bg-gray-600 text-gray-300" onClick={async () => {
              try {
                await api.todos.update(todo._id, { archived: !todo.archived } as Partial<Todo>);
                loadTodo();
              } catch (err: any) {
                showError(err.message || 'Archivierung fehlgeschlagen');
              }
            }}>
              {todo.archived ? 'Wiederherstellen' : 'Archivieren'}
            </Button>
            <ConfirmButton
              onConfirm={async () => {
                try {
                  await api.todos.delete(todoId!);
                  navigate(`/projects/${id}`);
                } catch (err: any) {
                  showError(err.message || 'Löschen fehlgeschlagen');
                }
              }}
              size="sm"
              className="sm:ml-auto"
            />
          </div>

          <div className="border-t border-gray-800 pt-5">
            <h3 className="text-sm font-medium text-gray-400 mb-3">
              Kommentare {comments.length > 0 && <span className="text-gray-600">({comments.length})</span>}
            </h3>
            <div className="space-y-2 mb-3">
              {comments.length === 0 && <p className="text-xs text-gray-700 italic">Noch keine Kommentare</p>}
              {comments.map((c, i) => (
                <div key={i} className="text-xs bg-gray-900 border border-gray-800 rounded p-2.5">
                  <div className="flex justify-between text-gray-500 mb-1">
                    <span className={c.author === 'claude' ? 'text-blue-400' : 'text-gray-400'}>{c.author}</span>
                    <span>{new Date(c.createdAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <Markdown className="text-gray-300">{c.text}</Markdown>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" value={commentText} onChange={(e) => setCommentText(e.target.value)}
                placeholder="Kommentar schreiben..." onKeyDown={(e) => e.key === 'Enter' && handleAddComment()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
              <Button type="button" variant="primary" onClick={handleAddComment} disabled={savingComment || !commentText.trim()}>
                {savingComment ? '...' : 'Senden'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
