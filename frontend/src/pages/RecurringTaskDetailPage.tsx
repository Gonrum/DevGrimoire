import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { api, RecurringTask, RecurringFrequency, Todo } from '../api/client';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import Badge from '../components/ui/Badge';
import { FormInput, FormSelect } from '../components/ui/FormField';
import { useToast } from '../components/Toast';
import { LoadingText } from '../components/ui/LoadingSpinner';

const FREQUENCIES: RecurringFrequency[] = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

export default function RecurringTaskDetailPage() {
  const { id, recurringTaskId } = useParams<{ id?: string; recurringTaskId: string }>();
  const location = useLocation();
  const isCustomerScope = location.pathname.startsWith('/customers/');
  const backLink = id
    ? isCustomerScope
      ? `/customers/${id}?tab=workflows`
      : `/projects/${id}?tab=recurring-tasks`
    : '/recurring-tasks';
  const backLabel = id
    ? isCustomerScope
      ? 'recurringTasks.backToCustomer'
      : 'recurringTasks.backToProject'
    : 'recurringTasks.globalTitle';
  const todoLinkBase = id
    ? isCustomerScope
      ? `/customers/${id}/todos`
      : `/projects/${id}/todos`
    : null;
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [task, setTask] = useState<RecurringTask | null>(null);
  const [createdTodos, setCreatedTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);

  // Edit form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [tags, setTags] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('weekly');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [month, setMonth] = useState(1);
  const [hour, setHour] = useState(9);

  const loadTask = async () => {
    if (!recurringTaskId) return;
    try {
      const rt = await api.recurringTasks.get(recurringTaskId);
      setTask(rt);
      setTitle(rt.title);
      setDescription(rt.description || '');
      setPriority(rt.priority || 'medium');
      setTags(rt.tags.join(', '));
      setFrequency(rt.frequency);
      setDayOfWeek(rt.dayOfWeek ?? 1);
      setDayOfMonth(rt.dayOfMonth ?? 1);
      setMonth(rt.month ?? 1);
      setHour(rt.hour);

      // Load created todos (last 10) — only for project-bound tasks
      if (rt.projectId && rt.createdTodoIds.length > 0) {
        const lastIds = rt.createdTodoIds.slice(-10);
        const todos = await Promise.all(
          lastIds.map((tid) => api.todos.get(tid).catch(() => null)),
        );
        setCreatedTodos(todos.filter(Boolean) as Todo[]);
      }
    } catch {
      setTask(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTask(); }, [recurringTaskId]);

  const handleSave = async () => {
    if (!recurringTaskId) return;
    setSaving(true);
    try {
      const showDoW = frequency === 'weekly' || frequency === 'biweekly';
      const showDoM = frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly';
      const showMo = frequency === 'yearly';

      await api.recurringTasks.update(recurringTaskId, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority as any,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        frequency,
        dayOfWeek: showDoW ? dayOfWeek : undefined,
        dayOfMonth: showDoM ? dayOfMonth : undefined,
        month: showMo ? month : undefined,
        hour,
      });
      setEditing(false);
      await loadTask();
      showSuccess(t('common.saved'));
    } catch (err: any) {
      showError(err.message || t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    if (!recurringTaskId || !task) return;
    try {
      await api.recurringTasks.update(recurringTaskId, { active: !task.active });
      await loadTask();
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handleTrigger = async () => {
    if (!recurringTaskId) return;
    setTriggering(true);
    try {
      await api.recurringTasks.trigger(recurringTaskId);
      await loadTask();
      showSuccess(t('recurringTasks.triggered'));
    } catch (err: any) {
      showError(err.message);
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = async () => {
    if (!recurringTaskId) return;
    try {
      await api.recurringTasks.delete(recurringTaskId);
      navigate(backLink);
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  if (loading) return <LoadingText />;
  if (!task) return <p className="text-red-400">{t('recurringTasks.notFound')}</p>;

  const showDoW = frequency === 'weekly' || frequency === 'biweekly';
  const showDoM = frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly';
  const showMo = frequency === 'yearly';

  return (
    <div>
      <Link to={backLink} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">
        &larr; {t(backLabel)}
      </Link>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-xl font-bold">{task.title}</h1>
        <Badge color={task.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'}>
          {task.active ? t('common.active') : t('recurringTasks.paused')}
        </Badge>
        <Badge color="bg-violet-900/40 text-violet-300">
          {t(`recurringTasks.freq_${task.frequency}`)}
        </Badge>
        {!task.projectId && (
          <Badge color="bg-cyan-900/30 text-cyan-300">{t('recurringTasks.systemWide')}</Badge>
        )}
      </div>

      <div className="max-w-3xl space-y-6">
        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleToggleActive}>
            {task.active ? t('recurringTasks.pause') : t('recurringTasks.activate')}
          </Button>
          <Button size="sm" variant="primary" onClick={handleTrigger} disabled={triggering}>
            {triggering ? t('common.saving') : t('recurringTasks.triggerNow')}
          </Button>
          <Button size="sm" onClick={() => setEditing(!editing)}>
            {editing ? t('common.cancel') : t('common.edit')}
          </Button>
          <ConfirmButton onConfirm={handleDelete} label={t('common.delete')} confirmLabel={t('common.confirmDelete')} variant="danger" size="sm" />
        </div>

        {/* Edit Form */}
        {editing && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-4">
            <FormInput label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
              <MarkdownEditor value={description} onChange={setDescription} rows={3} />
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <FormSelect label={t('common.priority')} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">{t('todoPriority.low')}</option>
                <option value="medium">{t('todoPriority.medium')}</option>
                <option value="high">{t('todoPriority.high')}</option>
                <option value="critical">{t('todoPriority.critical')}</option>
              </FormSelect>
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">{t('common.tags')}</label>
                <input type="text" value={tags} onChange={(e) => setTags(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500" />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <FormSelect label={t('recurringTasks.frequency')} value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>{t(`recurringTasks.freq_${f}`)}</option>
                ))}
              </FormSelect>
              {showDoW && (
                <FormSelect label={t('recurringTasks.dayOfWeek')} value={String(dayOfWeek)} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <option key={d} value={d}>{t(`recurringTasks.day_${d}`)}</option>
                  ))}
                </FormSelect>
              )}
              {showDoM && (
                <FormSelect label={t('recurringTasks.dayOfMonth')} value={String(dayOfMonth)} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}.</option>
                  ))}
                </FormSelect>
              )}
              {showMo && (
                <FormSelect label={t('recurringTasks.month')} value={String(month)} onChange={(e) => setMonth(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{t(`recurringTasks.month_${m}`)}</option>
                  ))}
                </FormSelect>
              )}
              <FormSelect label={t('recurringTasks.hour')} value={String(hour)} onChange={(e) => setHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                  <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
                ))}
              </FormSelect>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleSave} disabled={saving || !title.trim()}>
                {saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
            </div>
          </div>
        )}

        {/* Info */}
        {!editing && (
          <div className="space-y-3">
            {task.description && (
              <div>
                <span className="text-xs text-gray-500">{t('common.description')}</span>
                <div className="mt-1 text-gray-300">
                  <Markdown>{task.description}</Markdown>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-500">
              <span>{t('recurringTasks.nextRun')}: <span className="text-gray-300">{new Date(task.nextRun).toLocaleString(dateFmtLocale)}</span></span>
              {task.lastRun && <span>{t('recurringTasks.lastRun')}: <span className="text-gray-300">{new Date(task.lastRun).toLocaleString(dateFmtLocale)}</span></span>}
              <span>{t('recurringTasks.hour')}: <span className="text-gray-300">{`${String(task.hour).padStart(2, '0')}:00`}</span></span>
              <span>{t('common.created')}: <span className="text-gray-300">{new Date(task.createdAt).toLocaleDateString(dateFmtLocale)}</span></span>
            </div>
            {task.priority && (
              <div className="flex gap-2">
                <Badge color={
                  task.priority === 'critical' ? 'bg-red-900/40 text-red-300' :
                  task.priority === 'high' ? 'bg-orange-900/40 text-orange-300' :
                  task.priority === 'medium' ? 'bg-yellow-900/40 text-yellow-300' :
                  'bg-gray-800 text-gray-400'
                }>
                  {t(`todoPriority.${task.priority}`)}
                </Badge>
              </div>
            )}
            {task.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {task.tags.map((tag) => (
                  <Badge key={tag} color="bg-cyan-900/30 text-cyan-300">{tag}</Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Created Todos */}
        {createdTodos.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('recurringTasks.createdTodos')} ({task.createdTodoIds.length})</h2>
            <div className="space-y-1">
              {createdTodos.reverse().map((todo) => (
                <Link
                  key={todo._id}
                  to={todoLinkBase ? `${todoLinkBase}/${todo._id}` : '#'}
                  className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 py-1"
                >
                  <Badge color={
                    todo.status === 'done' ? 'bg-green-900/40 text-green-300' :
                    todo.status === 'review' ? 'bg-purple-900/40 text-purple-300' :
                    todo.status === 'in_progress' ? 'bg-blue-900/40 text-blue-300' :
                    'bg-gray-800 text-gray-400'
                  }>
                    {t(`todoStatus.${todo.status}`)}
                  </Badge>
                  <span className="truncate">{todo.displayNumber ? `${todo.displayNumber} — ` : ''}{todo.title}</span>
                  <span className="text-xs text-gray-600 shrink-0">{new Date(todo.createdAt).toLocaleDateString(dateFmtLocale)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
