import { FormEvent, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Todo, Milestone, Question } from '../api/client';
import {
  PRIORITY_COLORS, PRIORITY_LABELS,
  STATUS_COLORS, STATUS_LABELS, STATUS_TRANSITIONS, TRANSITION_BUTTON_VARIANT,
} from '../components/todo-utils';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmButton from '../components/ui/ConfirmButton';
import DetailSection from '../components/ui/DetailSection';
import { FormInput, FormSelect } from '../components/ui/FormField';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import TodoDependenciesSection from '../components/todo/TodoDependenciesSection';
import TodoQuestionsSection from '../components/todo/TodoQuestionsSection';
import AttachmentList from '../components/AttachmentList';

function TodoEditForm({ todo, onSaved, onCancel }: { todo: Todo; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description || '');
  const [priority, setPriority] = useState(todo.priority);
  const [tags, setTags] = useState(todo.tags.join(', '));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
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
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormInput label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
        <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder={t('todos.descriptionPlaceholder')} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <FormSelect fieldClassName="w-full sm:w-44 shrink-0" label={t('common.priority')} value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}>
          <option value="low">{t('todoPriority.low')}</option>
          <option value="medium">{t('todoPriority.medium')}</option>
          <option value="high">{t('todoPriority.high')}</option>
          <option value="critical">{t('todoPriority.critical')}</option>
        </FormSelect>
        <FormInput fieldClassName="flex-1 min-w-0 w-full" label={t('common.tags')} type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('common.commaSeparated')} />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <Button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export default function TodoDetailPage() {
  const { id, todoId } = useParams<{ id: string; todoId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isCustomerScope = location.pathname.startsWith('/customers/');
  const basePath = isCustomerScope ? `/customers/${id}` : `/projects/${id}`;
  const backLabelKey = isCustomerScope ? 'todoDetail.backToCustomer' : 'todoDetail.backToProject';
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [todo, setTodo] = useState<Todo | null>(null);
  const [allTodos, setAllTodos] = useState<Todo[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const loadTodo = () => {
    if (!todoId) return;
    api.todos.get(todoId)
      .then(setTodo)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadQuestions = () => {
    if (!todoId) return;
    api.questions.byTodo(todoId, true)
      .then(setQuestions)
      .catch(() => setQuestions([]));
  };

  useEffect(() => { loadTodo(); loadQuestions(); }, [todoId]);
  useEffect(() => {
    if (!id) return;
    if (isCustomerScope) {
      api.todos.list({ customerId: id }).then(setAllTodos);
      setMilestones([]);
      setStorageEnabled(false);
      return;
    }
    api.milestones.list(id).then(setMilestones);
    api.todos.list({ projectId: id }).then(setAllTodos);
    api.attachments.storageStatus().then((s) => setStorageEnabled(s.enabled)).catch(() => {});
  }, [id, isCustomerScope]);

  const handleStatusChange = async (newStatus: Todo['status']) => {
    if (!todoId) return;
    try {
      await api.todos.update(todoId, { status: newStatus });
      loadTodo();
    } catch (err: any) {
      showError(err.message || t('todos.statusChangeFailed'));
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
        <Link to={basePath} className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">&larr; {t(backLabelKey)}</Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">{error || t('todoDetail.notFound')}</p>
        </div>
      </div>
    );
  }

  const comments = todo.comments || [];

  return (
    <WorkflowPageShell backTo={basePath} backLabel={t(backLabelKey)}>
      {editing ? (
        <div>
          <h2 className="text-lg font-semibold mb-4">{t('todoDetail.editTask')}</h2>
          <TodoEditForm todo={todo} onSaved={() => { setEditing(false); loadTodo(); }} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <div>
          <h1 className="text-xl font-bold mb-3">{todo.displayNumber && <span className="text-gray-500 font-normal mr-2">{todo.displayNumber}</span>}{todo.title}</h1>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Badge color={STATUS_COLORS[todo.status]} rounded="full">
              {STATUS_LABELS[todo.status]()}
            </Badge>
            <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>
              {PRIORITY_LABELS[todo.priority]()}
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
            <DetailSection title={t('todoCreate.milestone')} className="mb-5">
              <FormSelect
                value={todo.milestoneId || ''}
                onChange={async (e) => {
                  try {
                    await api.todos.update(todo._id, { milestoneId: e.target.value || undefined } as Partial<Todo>);
                    loadTodo();
                  } catch (err: any) {
                    showError(err.message || t('todoDetail.milestoneChangeFailed'));
                  }
                }}
              >
                <option value="">{t('todoCreate.noMilestone')}</option>
                {milestones.map((ms) => (
                  <option key={ms._id} value={ms._id}>{ms.name}</option>
                ))}
              </FormSelect>
            </DetailSection>
          )}

          {!isCustomerScope && (
            <TodoDependenciesSection
              todo={todo}
              allTodos={allTodos}
              projectId={id}
              onChanged={loadTodo}
              onError={showError}
              className="mb-5"
            />
          )}

          <div className="text-xs text-gray-600 mb-5 space-y-0.5">
            <p>{t('common.created')}: {new Date(todo.createdAt).toLocaleString(i18n.language === 'de' ? 'de-DE' : 'en-US')}</p>
            {todo.updatedAt !== todo.createdAt && (
              <p>{t('common.updated')}: {new Date(todo.updatedAt).toLocaleString(i18n.language === 'de' ? 'de-DE' : 'en-US')}</p>
            )}
          </div>

          <DetailSection title={t('common.actions')} className="mb-8">
            <div className="flex flex-wrap items-center gap-2">
            {STATUS_TRANSITIONS[todo.status].map((tr) => (
              <Button key={tr.next} type="button" variant={TRANSITION_BUTTON_VARIANT[tr.next]} size="sm" onClick={() => handleStatusChange(tr.next)}>
                {tr.label()}
              </Button>
            ))}
            <Button type="button" variant="edit" size="sm" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
            <Button type="button" variant="neutral" size="sm" onClick={async () => {
              try {
                await api.todos.update(todo._id, { archived: !todo.archived } as Partial<Todo>);
                loadTodo();
              } catch (err: any) {
                showError(err.message || t('todos.archiveFailed'));
              }
            }}>
              {todo.archived ? t('common.restore') : t('common.archive')}
            </Button>
            <ConfirmButton
              onConfirm={async () => {
                try {
                  await api.todos.delete(todoId!);
                  navigate(basePath);
                } catch (err: any) {
                  showError(err.message || t('todos.deleteFailed'));
                }
              }}
              size="sm"
              className="sm:ml-auto"
            />
            </div>
          </DetailSection>

          <TodoQuestionsSection
            todoId={todoId!}
            projectId={todo.projectId}
            questions={questions}
            onChanged={() => { loadQuestions(); loadTodo(); }}
            onError={showError}
          />

          <DetailSection title={t('todoDetail.comments')} meta={comments.length > 0 ? `(${comments.length})` : undefined}>
            <div className="space-y-2 mb-3">
              {comments.length === 0 && <p className="text-xs text-gray-700 italic">{t('todoDetail.noComments')}</p>}
              {comments.map((c, i) => (
                <div key={i} className="text-xs bg-gray-900 border border-gray-800 rounded p-2.5">
                  <div className="flex justify-between text-gray-500 mb-1">
                    <span className={c.author === 'claude' ? 'text-cyan-400' : 'text-gray-400'}>{c.author}</span>
                    <span>{new Date(c.createdAt).toLocaleString(i18n.language === 'de' ? 'de-DE' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <Markdown className="text-gray-300">{c.text}</Markdown>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <FormInput
                fieldClassName="flex-1 min-w-0 w-full"
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder={t('todoDetail.commentPlaceholder')}
                onKeyDown={(e) => e.key === 'Enter' && handleAddComment()}
              />
              <Button type="button" variant="primary" onClick={handleAddComment} disabled={savingComment || !commentText.trim()}>
                {savingComment ? '...' : t('common.send')}
              </Button>
            </div>
          </DetailSection>

          {storageEnabled && (
            <DetailSection title={t('attachments.attachments')}>
              <AttachmentList
                projectId={id!}
                entityType="todo"
                entityId={todoId!}
                showUpload
              />
            </DetailSection>
          )}
        </div>
      )}
    </WorkflowPageShell>
  );
}
