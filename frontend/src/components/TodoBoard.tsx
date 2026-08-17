import { useState, useMemo, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Todo, Milestone, QuestionsByTodoSummary, api } from '../api/client';
import { errorMessage } from '../lib/narrow';
import i18n from '../i18n';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import {
  COLUMNS, PRIORITY_COLORS, PRIORITY_LABELS,
  STATUS_COLORS, STATUS_LABELS, STATUS_TRANSITIONS,
} from './todo-utils';
import { useToast } from './Toast';
import Button from './ui/Button';
import ButtonLink from './ui/ButtonLink';
import ConfirmButton from './ui/ConfirmButton';
import TabToolbar from './ui/TabToolbar';

interface Props {
  todos: Todo[];
  milestones: Milestone[];
  /** Project context — set this OR customerId, not both. */
  projectId?: string;
  /** Customer context — set this OR projectId, not both. */
  customerId?: string;
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
      case 'title': return a.title.localeCompare(b.title, i18n.language);
      case 'created': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'updated':
      default: return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
  });
  return sortDir === 'asc' ? sorted : sorted.reverse();
}

function TodoEditForm({ todo, onSaved, onCancel }: { todo: Todo; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
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
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-violet-500" autoFocus />
      <MarkdownEditor value={description} onChange={setDescription} rows={2} placeholder={t('todos.descriptionPlaceholder')} />
      <div className="flex gap-2 items-center">
        <select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500">
          <option value="low">{t('todoPriority.low')}</option>
          <option value="medium">{t('todoPriority.medium')}</option>
          <option value="high">{t('todoPriority.high')}</option>
          <option value="critical">{t('todoPriority.critical')}</option>
        </select>
        <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('common.tags')}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="xs" disabled={saving || !title.trim()}>
          {saving ? '...' : t('common.save')}
        </Button>
        <Button type="button" size="xs" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function TodoComments({ todo, onUpdate }: { todo: Todo; onUpdate: () => void }) {
  const { t } = useTranslation();
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
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  return (
    <div className="mt-2" onClick={(e) => e.preventDefault()}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        {comments.length > 0 ? t('todos.commentCount', { count: comments.length }) : t('todos.addComment')}
        {expanded ? ' \u25B4' : ' \u25BE'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {comments.map((c, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
              <div className="flex justify-between text-gray-500 mb-0.5">
                <span className={c.author === 'claude' ? 'text-cyan-400' : 'text-gray-400'}>{c.author}</span>
                <span>{new Date(c.createdAt).toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <Markdown className="text-gray-300">{c.text}</Markdown>
            </div>
          ))}
          <div className="flex gap-2">
            <input type="text" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={t('todos.commentPlaceholder')} onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              aria-label={t('todos.commentPlaceholder')}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
            <Button type="button" size="xs" onClick={handleAdd} disabled={saving || !text.trim()}>
              {saving ? '...' : t('common.send')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AcceptanceProgressBadge({ todo }: { todo: Todo }) {
  const { t } = useTranslation();
  const criteria = todo.acceptanceCriteria;
  if (!criteria || criteria.length === 0) return null;
  const total = criteria.length;
  const done = criteria.filter((c) => c.done).length;
  const colorClass = done === total
    ? 'bg-green-900/40 text-green-300'
    : done > 0
      ? 'bg-yellow-900/40 text-yellow-300'
      : 'bg-gray-800 text-gray-400';
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] ${colorClass}`}
      title={t('todos.acceptanceProgress', { done, total })}
    >
      <span aria-hidden="true">☑</span>
      <span>{done}/{total}</span>
    </span>
  );
}

function QuestDefinedIcon({ todo }: { todo: Todo }) {
  const { t } = useTranslation();
  const hasDef =
    (todo.userStories?.trim() ?? '') !== '' ||
    (todo.outOfScope?.trim() ?? '') !== '' ||
    (todo.edgeCases?.trim() ?? '') !== '';
  if (!hasDef) return null;
  return (
    <span
      className="text-gray-500 text-[11px] leading-none"
      title={t('todos.questDefined')}
      aria-hidden="true"
    >
      📋
    </span>
  );
}

function TodoCard({ todo, allTodos, basePath, onUpdate, onDragStart, showError, questionSummary }: { todo: Todo; allTodos: Todo[]; basePath: string; onUpdate: () => void; onDragStart?: (todoId: string) => void; showError: (msg: string) => void; questionSummary?: QuestionsByTodoSummary }) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [animClass, setAnimClass] = useState('');
  const prevStatusRef = useRef(todo.status);

  useEffect(() => {
    if (prevStatusRef.current !== todo.status) {
      const cls = todo.status === 'done' ? 'quest-status-done' : 'quest-status-changed';
      setAnimClass(cls);
      prevStatusRef.current = todo.status;
      const timer = setTimeout(() => setAnimClass(''), 1500);
      return () => clearTimeout(timer);
    }
  }, [todo.status]);

  const hasBlockers = (todo.blockedBy || []).some((bid) => {
    const blocker = allTodos.find((t) => t._id === bid);
    return blocker && blocker.status !== 'done';
  });

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const handleStatusChange = async (newStatus: Todo['status']) => {
    try {
      await api.todos.update(todo._id, { status: newStatus });
      onUpdate();
    } catch (err) {
      showError(errorMessage(err, t('todos.statusChangeFailed')));
    }
  };

  const handleArchiveToggle = async () => {
    try {
      await api.todos.update(todo._id, { archived: !todo.archived });
      onUpdate();
    } catch (err) {
      showError(errorMessage(err, t('todos.archiveFailed')));
    }
  };

  if (editing) {
    return (
      <div className="bg-gray-900 border border-violet-800 rounded-lg p-3">
        <TodoEditForm todo={todo} onSaved={() => { setEditing(false); onUpdate(); }} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  const hasOpenQuestion = !!questionSummary && questionSummary.total > 0;
  const cardBorder = hasOpenQuestion
    ? 'border-violet-600/70 shadow-[0_0_18px_rgba(124,58,237,0.18)] hover:border-violet-400'
    : 'border-gray-800 hover:border-gray-700';

  return (
    <Link to={`${basePath}/todos/${todo._id}`}
      draggable
      aria-roledescription={t('todos.draggableTask')}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(todo._id); }}
      onDragEnd={() => onDragStart?.('')}
      className={`block bg-gray-900 border rounded-lg p-3 group transition-colors cursor-grab active:cursor-grabbing ${cardBorder} ${animClass}`}>
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium flex items-center gap-1 flex-wrap">
          {hasBlockers && <span className="text-red-400 mr-1" title={t('todos.blocked')}>&#x26D4;</span>}
          {todo.displayNumber && <span className="text-gray-500 font-normal mr-1.5">{todo.displayNumber}</span>}
          {todo.title}
          <QuestDefinedIcon todo={todo} />
        </h4>
        <div className="flex items-center gap-1.5 shrink-0">
          <AcceptanceProgressBadge todo={todo} />
          <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>
            {PRIORITY_LABELS[todo.priority]()}
          </span>
        </div>
      </div>
      {hasOpenQuestion && <QuestionFlag summary={questionSummary} className="mt-1.5" />}
      {todo.description && (
        <div className="mt-1 max-h-20 overflow-hidden text-gray-500">
          <Markdown>{todo.description}</Markdown>
        </div>
      )}
      <p className="text-xs text-gray-600 mt-1">
        {new Date(todo.createdAt).toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: '2-digit' })}
        {todo.updatedAt !== todo.createdAt && (
          <span> · {t('todos.edited')} {new Date(todo.updatedAt).toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
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
          <Button key={tr.next} type="button" size="xs" onClick={() => handleStatusChange(tr.next)}>{tr.label()}</Button>
        ))}
        <Button type="button" size="xs" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
        <Button type="button" size="xs" onClick={handleArchiveToggle}>{todo.archived ? t('common.restore') : t('common.archive')}</Button>
        <ConfirmButton onConfirm={async () => {
          try {
            await api.todos.delete(todo._id);
            onUpdate();
          } catch (err) {
            showError(errorMessage(err, t('todos.deleteFailed')));
          }
        }} className="ml-auto" />
      </div>
    </Link>
  );
}

function TodoListRow({ todo, basePath, onUpdate, showError, questionSummary }: { todo: Todo; basePath: string; onUpdate: () => void; showError: (msg: string) => void; questionSummary?: QuestionsByTodoSummary }) {
  const { t, i18n } = useTranslation();
  const [animClass, setAnimClass] = useState('');
  const prevStatusRef = useRef(todo.status);

  useEffect(() => {
    if (prevStatusRef.current !== todo.status) {
      const cls = todo.status === 'done' ? 'quest-status-done' : 'quest-status-changed';
      setAnimClass(cls);
      prevStatusRef.current = todo.status;
      const timer = setTimeout(() => setAnimClass(''), 1500);
      return () => clearTimeout(timer);
    }
  }, [todo.status]);

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const handleStatusChange = async (e: React.MouseEvent, newStatus: Todo['status']) => {
    e.preventDefault();
    try {
      await api.todos.update(todo._id, { status: newStatus });
      onUpdate();
    } catch (err) {
      showError(errorMessage(err, t('todos.statusChangeFailed')));
    }
  };

  const comments = todo.comments || [];

  const hasOpenQuestion = !!questionSummary && questionSummary.total > 0;

  return (
    <tr className={`border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors ${hasOpenQuestion ? 'bg-violet-950/15' : ''} ${animClass}`}>
      <td className="py-2.5 px-3">
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[todo.status]}`}>
          {STATUS_LABELS[todo.status]()}
        </span>
      </td>
      <td className="py-2.5 px-3">
        <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>
          {PRIORITY_LABELS[todo.priority]()}
        </span>
      </td>
      <td className="py-2.5 px-3">
        <Link to={`${basePath}/todos/${todo._id}`} className="hover:text-cyan-400 transition-colors">
          <div className="text-sm flex items-center gap-2">
            {todo.displayNumber && <span className="text-gray-500 mr-1">{todo.displayNumber}</span>}
            <span>{todo.title}</span>
            <QuestDefinedIcon todo={todo} />
            {hasOpenQuestion && <QuestionFlag summary={questionSummary} compact />}
            <AcceptanceProgressBadge todo={todo} />
          </div>
          {todo.description && <div className="text-xs text-gray-600 line-clamp-1 mt-0.5">{todo.description}</div>}
        </Link>
      </td>
      <td className="py-2.5 px-3 hidden sm:table-cell">
        <div className="flex flex-wrap gap-1">
          {todo.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      </td>
      <td className="py-2.5 px-3 text-xs text-gray-600 hidden sm:table-cell">
        {comments.length > 0 && <span>{comments.length}</span>}
      </td>
      <td className="py-2.5 px-3 text-xs text-gray-600 whitespace-nowrap">
        {new Date(todo.updatedAt).toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: '2-digit' })}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex gap-1">
          {STATUS_TRANSITIONS[todo.status].map((tr) => (
            <Button key={tr.next} type="button" size="xs" onClick={(e) => handleStatusChange(e, tr.next)}>{tr.label()}</Button>
          ))}
        </div>
      </td>
    </tr>
  );
}

type ViewMode = 'kanban' | 'list';

export default function TodoBoard({ todos, milestones, projectId, customerId, onUpdate }: Props) {
  const basePath = projectId ? `/projects/${projectId}` : `/customers/${customerId}`;
  const { t } = useTranslation();
  const { showError } = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [searchQuery, setSearchQuery] = useState('');
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
  const [questionMap, setQuestionMap] = useState<Record<string, QuestionsByTodoSummary>>({});

  // Fetch open-question counts for all currently-loaded todos. Used to render
  // the violet "Rückfrage offen" accent on todo cards/rows (M-30 / T-245).
  useEffect(() => {
    const ids = todos.map((todo) => todo._id);
    if (ids.length === 0) {
      setQuestionMap({});
      return;
    }
    let cancelled = false;
    api.questions
      .byTodos(ids)
      .then((map) => { if (!cancelled) setQuestionMap(map); })
      .catch(() => { if (!cancelled) setQuestionMap({}); });
    return () => { cancelled = true; };
  }, [todos]);

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
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const numberMatch = q.match(/^t?-?(\d+)$/i);
      if (numberMatch) {
        const num = parseInt(numberMatch[1], 10);
        result = result.filter((t) =>
          t.number === num ||
          t.displayNumber?.toLowerCase() === q ||
          t.title.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q),
        );
      } else {
        result = result.filter((t) =>
          t.title.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
        );
      }
    }
    return sortTodos(result, sortKey, sortDir);
  }, [todos, showArchived, searchQuery, filterStatus, filterPriority, filterMilestone, filterTag, sortKey, sortDir]);

  const hasFilters = !!(searchQuery.trim() || filterStatus || filterPriority || filterMilestone || filterTag);

  const clearFilters = () => {
    setSearchQuery('');
    setFilterStatus('');
    setFilterPriority('');
    setFilterMilestone('');
    setFilterTag('');
  };

  const selectClass = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-violet-500';

  return (
    <div>
      <TabToolbar
        className="mb-4"
        primaryAction={(
          <ButtonLink to={`${basePath}/todos/new`} variant="primary" size="sm">
            {t('todos.newTask')}
          </ButtonLink>
        )}
        search={(
          <input type="search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
            placeholder={t('todos.searchPlaceholder')} aria-label={t('todos.searchPlaceholder')}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
        )}
        filters={(
          <>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="Status filtern" className={selectClass}>
              <option value="">{t('todos.allStatus')}</option>
              {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label()}</option>)}
            </select>
            <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} aria-label="Priorität filtern" className={selectClass}>
              <option value="">{t('todos.allPriorities')}</option>
              <option value="critical">{t('todoPriority.critical')}</option>
              <option value="high">{t('todoPriority.high')}</option>
              <option value="medium">{t('todoPriority.medium')}</option>
              <option value="low">{t('todoPriority.low')}</option>
            </select>
            {milestones.length > 0 && (
              <select value={filterMilestone} onChange={(e) => setFilterMilestone(e.target.value)} aria-label="Milestone filtern" className={selectClass}>
                <option value="">{t('todos.allMilestones')}</option>
                <option value="_none">{t('todos.noMilestone')}</option>
                {milestones.map((ms) => <option key={ms._id} value={ms._id}>{ms.name}</option>)}
              </select>
            )}
            {allTags.length > 0 && (
              <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} aria-label="Tag filtern" className={selectClass}>
                <option value="">{t('todos.allTags')}</option>
                {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            )}
            {hasFilters && (
              <button type="button" onClick={clearFilters} className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300 transition-colors">
                {t('todos.resetFilters')}
              </button>
            )}
          </>
        )}
        viewToggle={(
          <>
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              <button type="button" onClick={() => setViewMode('kanban')}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${viewMode === 'kanban' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
                {t('todos.kanban')}
              </button>
              <button type="button" onClick={() => setViewMode('list')}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${viewMode === 'list' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
                {t('todos.list')}
              </button>
            </div>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sortierung" className={selectClass}>
              <option value="updated">{t('todos.sortUpdated')}</option>
              <option value="created">{t('todos.sortCreated')}</option>
              <option value="priority">{t('todos.sortPriority')}</option>
              <option value="title">{t('todos.sortTitle')}</option>
            </select>
            <button type="button" onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
              className="text-xs px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200 transition-colors"
              title={sortDir === 'asc' ? t('todos.ascending') : t('todos.descending')}>
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </>
        )}
        secondaryActions={(
          <>
            {archivableDone.length > 0 && (
              <button type="button" onBlur={() => setConfirmArchiveAll(false)} onClick={async () => {
                if (!confirmArchiveAll) { setConfirmArchiveAll(true); return; }
                setConfirmArchiveAll(false);
                try {
                  await Promise.all(archivableDone.map((t) => api.todos.update(t._id, { archived: true })));
                  onUpdate();
                } catch (err) {
                  showError(errorMessage(err, t('todos.archiveFailed')));
                }
              }}
                className={`text-xs px-2 py-1 rounded transition-colors ${confirmArchiveAll ? 'bg-yellow-900/60 text-yellow-300' : 'text-gray-600 hover:text-gray-400'}`}>
                {confirmArchiveAll ? t('todos.archiveConfirm', { count: archivableDone.length }) : t('todos.archiveCompleted', { count: archivableDone.length })}
              </button>
            )}
            {archivedCount > 0 && (
              <button type="button" onClick={() => setShowArchived(!showArchived)}
                className={`text-xs px-2 py-1 rounded transition-colors ${showArchived ? 'bg-gray-700 text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}>
                {showArchived ? t('todos.hideArchive', { count: archivedCount }) : t('todos.showArchive', { count: archivedCount })}
              </button>
            )}
          </>
        )}
      />


      {hasFilters && (
        <p className="text-xs text-gray-600 mb-3">{t('todos.filtered', { shown: filtered.length, total: todos.length })}</p>
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
                className={`border-t-2 ${isOver ? (isValidDrop ? 'border-violet-500 bg-violet-900/10' : 'border-red-500/50 bg-red-900/5') : col.color} pt-3 rounded-b-lg transition-colors`}
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
                    await api.todos.update(dragTodoId, { status: col.key });
                    onUpdate();
                  } catch (err) {
                    showError(errorMessage(err, t('todos.statusChangeFailed')));
                  }
                }}>
                <h3 className="text-sm font-medium text-gray-400 mb-3">
                  {col.label()}{' '}
                  <span className="text-gray-600">({items.length})</span>
                </h3>
                <div className="space-y-2 min-h-[2rem]" role="list" aria-label={col.label()}>
                  {items.map((todo) => (
                    <TodoCard key={todo._id} todo={todo} allTodos={todos} basePath={basePath} onUpdate={onUpdate}
                      onDragStart={(id) => setDragTodoId(id || null)} showError={showError}
                      questionSummary={questionMap[todo._id]} />
                  ))}
                  {items.length === 0 && !isOver && (
                    <p className="text-xs text-gray-700 italic">{t('todos.noEntries')}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-left min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500">
                <th className="py-2 px-3 font-medium">{t('todos.tableStatus')}</th>
                <th className="py-2 px-3 font-medium">{t('todos.tablePriority')}</th>
                <th className="py-2 px-3 font-medium">{t('todos.tableTitle')}</th>
                <th className="py-2 px-3 font-medium hidden sm:table-cell">{t('todos.tableTags')}</th>
                <th className="py-2 px-3 font-medium hidden sm:table-cell" title={t('common.comments')}>{t('todos.tableComments')}</th>
                <th className="py-2 px-3 font-medium">{t('todos.tableUpdated')}</th>
                <th className="py-2 px-3 font-medium">{t('todos.tableActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="py-4 text-center text-xs text-gray-700 italic">{t('todos.noTasks')}</td></tr>
              )}
              {filtered.map((todo) => (
                <TodoListRow key={todo._id} todo={todo} basePath={basePath} onUpdate={onUpdate} showError={showError}
                  questionSummary={questionMap[todo._id]} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QuestionFlag({ summary, compact, className }: { summary: QuestionsByTodoSummary; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (summary.pendingAgentToUser > 0) parts.push(t('questions.flagPendingAgent', { count: summary.pendingAgentToUser }));
  if (summary.expiredAgentToUser > 0) parts.push(t('questions.flagExpiredAgent', { count: summary.expiredAgentToUser }));
  if (summary.pendingUserToAgent > 0) parts.push(t('questions.flagPendingUser', { count: summary.pendingUserToAgent }));
  const label = parts.join(' · ');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-violet-700/60 bg-violet-950/40 text-violet-200 ${compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]'} ${className ?? ''}`}
      title={label}
      onClick={(e) => e.preventDefault()}
    >
      <span aria-hidden="true">&#x2753;</span>
      {!compact && <span>{label}</span>}
      {compact && <span>{summary.total}</span>}
    </span>
  );
}
