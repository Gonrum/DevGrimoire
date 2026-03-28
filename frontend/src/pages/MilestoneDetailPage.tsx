import { useEffect, useState, useRef, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Milestone, Todo, ChangelogEntry } from '../api/client';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmButton from '../components/ui/ConfirmButton';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { FormInput, FormSelect } from '../components/ui/FormField';

const STATUS_COLORS: Record<Milestone['status'], string> = {
  open: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-yellow-900 text-yellow-300',
  done: 'bg-green-900 text-green-300',
};

const PRIORITY_COLORS: Record<Todo['priority'], string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-gray-500',
};

function TodoAccordionItem({ todo, projectId }: { todo: Todo; projectId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const statusDot = todo.status === 'done' ? 'bg-green-500' :
    todo.status === 'review' ? 'bg-purple-500' :
    todo.status === 'in_progress' ? 'bg-yellow-500' : 'bg-gray-600';

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors text-left"
      >
        <svg className={`w-3.5 h-3.5 shrink-0 text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
        <span className={`flex-1 truncate ${todo.status === 'done' ? 'line-through text-gray-600' : ''}`}>
          {todo.displayNumber && <span className="text-gray-600 mr-1">{todo.displayNumber}</span>}
          {todo.title}
        </span>
        {todo.priority && todo.priority !== 'medium' && (
          <span className={`text-xs ${PRIORITY_COLORS[todo.priority]}`}>{t(`todoPriority.${todo.priority}`)}</span>
        )}
        <span className="text-xs text-gray-700 shrink-0">{t(`todoStatus.${todo.status}`)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-800/50 bg-gray-900/30">
          {todo.description ? (
            <Markdown className="text-sm text-gray-400 mb-3">{todo.description}</Markdown>
          ) : (
            <p className="text-xs text-gray-600 italic mb-3">{t('common.noPreview')}</p>
          )}
          {todo.tags && todo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {todo.tags.map((tag) => (
                <span key={tag} className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">{tag}</span>
              ))}
            </div>
          )}
          <Link to={`/projects/${projectId}/todos/${todo._id}`}>
            <Button type="button" size="sm" variant="none" className="bg-violet-900/60 hover:bg-violet-900 text-cyan-300">
              {t('common.edit')}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function CreateTodoModal({ projectId, milestoneId, onCreated, onClose }: { projectId: string; milestoneId: string; onCreated: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.attachments.storageStatus().then((s) => setStorageEnabled(s.enabled)).catch(() => {}); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const todo = await api.todos.create({
        projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status: 'open',
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        milestoneId,
      } as Partial<Todo> & { milestoneId?: string });

      if (pendingFiles.length > 0 && todo._id) {
        for (const file of pendingFiles) {
          await api.attachments.upload(projectId, file, { entityType: 'todo', entityId: todo._id }).catch(() => {});
        }
      }

      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-200">{t('todoCreate.title')}</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <FormInput label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.title')} autoFocus />
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
            <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder={t('todoCreate.descriptionPlaceholder')} />
          </div>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <FormSelect label={t('common.priority')} value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}>
              <option value="low">{t('todoPriority.low')}</option>
              <option value="medium">{t('todoPriority.medium')}</option>
              <option value="high">{t('todoPriority.high')}</option>
              <option value="critical">{t('todoPriority.critical')}</option>
            </FormSelect>
            <div className="flex-1 w-full sm:w-auto">
              <label className="block text-xs text-gray-500 mb-1">{t('common.tags')}</label>
              <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('todoCreate.tagsPlaceholder')}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
            </div>
          </div>
          {storageEnabled && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('attachments.attachments')}</label>
              <div
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg border-2 border-dashed border-gray-700 hover:border-gray-600 bg-gray-900/50 px-4 py-3 text-center cursor-pointer transition-colors"
              >
                <input ref={fileInputRef} type="file" multiple onChange={(e) => {
                  if (e.target.files) { setPendingFiles((prev) => [...prev, ...Array.from(e.target.files!)]); e.target.value = ''; }
                }} className="hidden" />
                {pendingFiles.length === 0 ? (
                  <p className="text-sm text-gray-500">{t('attachments.dropzone')}</p>
                ) : (
                  <div className="space-y-1">
                    {pendingFiles.map((f, i) => (
                      <div key={i} className="flex items-center justify-between text-sm text-gray-300">
                        <span className="truncate">{f.name}</span>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setPendingFiles((prev) => prev.filter((_, j) => j !== i)); }} className="text-red-400 hover:text-red-300 ml-2 text-xs">&times;</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
              {saving ? t('common.creating') : t('common.create')}
            </Button>
            <Button type="button" onClick={onClose}>{t('common.cancel')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MilestoneEditForm({ milestone, onSaved, onCancel }: { milestone: Milestone; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(milestone.name);
  const [description, setDescription] = useState(milestone.description || '');
  const [dueDate, setDueDate] = useState(milestone.dueDate ? milestone.dueDate.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.milestones.update(milestone._id, {
        name: name.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
      } as Partial<Milestone>);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('common.name')}</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500" autoFocus />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
        <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder={t('common.description')} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('milestoneCreate.dueDate')}</label>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500" />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <Button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function ChangelogForm({ milestone, onCompleted, onCancel, showError }: { milestone: Milestone; onCompleted: () => void; onCancel: () => void; showError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [clVersion, setClVersion] = useState('');
  const [clSummary, setClSummary] = useState('');
  const [clChanges, setClChanges] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const changes = clChanges.split('\n').map((l) => l.trim()).filter(Boolean);
    if (changes.length === 0) {
      showError(t('milestones.minOneChange'));
      return;
    }
    setSubmitting(true);
    try {
      const changelog = await api.changelog.create({
        projectId: milestone.projectId,
        version: clVersion || undefined,
        summary: clSummary || undefined,
        changes,
      });
      await api.milestones.update(milestone._id, { status: 'done', changelogId: changelog._id } as Partial<Milestone>);
      onCompleted();
    } catch (err: any) {
      showError(err.message || t('milestoneDetail.completeFailed'));
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-gray-300">{t('milestones.createChangelog')}</p>
      <p className="text-xs text-gray-500">{t('milestoneDetail.changelogRequired')}</p>
      <input
        type="text"
        placeholder={t('milestones.versionPlaceholder')}
        value={clVersion}
        onChange={(e) => setClVersion(e.target.value)}
        className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none"
      />
      <input
        type="text"
        placeholder={t('milestones.summaryPlaceholder')}
        value={clSummary}
        onChange={(e) => setClSummary(e.target.value)}
        className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none"
      />
      <textarea
        placeholder={t('milestones.changesPlaceholder')}
        value={clChanges}
        onChange={(e) => setClChanges(e.target.value)}
        rows={4}
        className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none resize-none"
        required
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? t('common.saving') : t('milestoneDetail.complete')}
        </Button>
        <Button type="button" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

export default function MilestoneDetailPage() {
  const { id, milestoneId } = useParams<{ id: string; milestoneId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [milestone, setMilestone] = useState<Milestone | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showChangelogForm, setShowChangelogForm] = useState(false);
  const [showCreateTodo, setShowCreateTodo] = useState(false);

  const loadMilestone = () => {
    if (!milestoneId) return;
    api.milestones.get(milestoneId)
      .then((ms) => {
        setMilestone(ms);
        if (ms.changelogId) {
          api.changelog.get(ms.changelogId).then(setChangelog).catch(() => setChangelog(null));
        } else {
          setChangelog(null);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadMilestone(); }, [milestoneId]);
  const loadTodos = () => { if (id) api.todos.list({ projectId: id }).then(setTodos); };
  useEffect(() => { loadTodos(); }, [id]);

  const handleStatusChange = async (newStatus: Milestone['status']) => {
    if (!milestoneId) return;
    try {
      await api.milestones.update(milestoneId, { status: newStatus });
      loadMilestone();
    } catch (err: any) {
      showError(err.message || t('milestoneDetail.statusChangeFailed'));
    }
  };

  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error || !milestone) {
    return (
      <div>
        <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">&larr; {t('milestoneDetail.backToProject')}</Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">{error || t('milestoneDetail.notFound')}</p>
        </div>
      </div>
    );
  }

  const milestoneTodos = todos.filter((t) => t.milestoneId === milestone._id);
  const doneTodos = milestoneTodos.filter((t) => t.status === 'done');
  const reviewTodos = milestoneTodos.filter((t) => t.status === 'review');
  const inProgressTodos = milestoneTodos.filter((t) => t.status === 'in_progress');
  const openTodos = milestoneTodos.filter((t) => t.status === 'open');
  const total = milestoneTodos.length;
  const donePercent = total > 0 ? Math.round((doneTodos.length / total) * 100) : 0;
  const reviewPercent = total > 0 ? Math.round((reviewTodos.length / total) * 100) : 0;

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('milestoneDetail.backToProject')}</Link>

      {editing ? (
        <div className="max-w-3xl mx-auto">
          <h2 className="text-lg font-semibold mb-4">{t('milestoneDetail.editMilestone')}</h2>
          <MilestoneEditForm milestone={milestone} onSaved={() => { setEditing(false); loadMilestone(); }} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <div className="max-w-3xl mx-auto">
          <h1 className="text-xl font-bold mb-3">
            {milestone.displayNumber && <span className="text-gray-500 font-normal mr-2">{milestone.displayNumber}</span>}
            {milestone.name}
          </h1>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Badge color={STATUS_COLORS[milestone.status]} rounded="full">
              {t(`milestoneStatus.${milestone.status}`)}
            </Badge>
            {milestone.dueDate && (
              <span className="text-xs text-gray-500">
                {t('milestones.due')}: {new Date(milestone.dueDate).toLocaleDateString(locale)}
              </span>
            )}
            {milestone.archived && (
              <Badge color="bg-gray-800 text-gray-500" rounded="full">{t('milestoneDetail.archived')}</Badge>
            )}
          </div>

          {milestone.description && (
            <Markdown className="text-gray-400 mb-5">{milestone.description}</Markdown>
          )}

          {/* Progress */}
          <div className="mb-5">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
              <span>
                {doneTodos.length} {t('milestoneDetail.progress')}
                {reviewTodos.length > 0 && <> · {reviewTodos.length} {t('milestoneDetail.inReview')}</>}
                {inProgressTodos.length > 0 && <> · {inProgressTodos.length} {t('milestoneDetail.inProgress')}</>}
                {' '}/ {total} {t('milestoneDetail.tasks')}
              </span>
              <span>{donePercent}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2 flex overflow-hidden">
              <div
                className={`h-2 transition-all ${donePercent + reviewPercent === 100 && reviewPercent === 0 ? 'bg-green-500' : 'bg-violet-500'}`}
                style={{ width: `${donePercent}%` }}
              />
              {reviewPercent > 0 && (
                <div className="h-2 bg-purple-500 transition-all" style={{ width: `${reviewPercent}%` }} />
              )}
            </div>
          </div>

          {/* Todo list (accordion) */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-400">
                {t('milestoneDetail.tasks')} <span className="text-gray-600">({milestoneTodos.length})</span>
              </h3>
              <Button type="button" size="sm" variant="none" className="bg-violet-900/60 hover:bg-violet-900 text-violet-300 text-xs"
                onClick={() => setShowCreateTodo(true)}>
                {t('milestoneDetail.newQuest')}
              </Button>
            </div>
            {milestoneTodos.length > 0 ? (
              <div className="space-y-1.5">
                {[...openTodos, ...inProgressTodos, ...reviewTodos, ...doneTodos].map((todo) => (
                  <TodoAccordionItem key={todo._id} todo={todo} projectId={id!} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">{t('milestoneDetail.noTasks')}</p>
            )}
          </div>

          {/* Create Todo Modal */}
          {showCreateTodo && (
            <CreateTodoModal
              projectId={id!}
              milestoneId={milestone._id}
              onCreated={() => { setShowCreateTodo(false); loadTodos(); }}
              onClose={() => setShowCreateTodo(false)}
            />
          )}

          {/* Linked Changelog */}
          {changelog && (
            <div className="mb-5 bg-gray-900 border border-gray-800 rounded-lg p-3">
              <h3 className="text-sm font-medium text-gray-400 mb-2">{t('milestoneDetail.changelog')}</h3>
              {changelog.version && <p className="text-xs text-gray-500 mb-1">{t('common.version')}: {changelog.version}</p>}
              {changelog.summary && <p className="text-xs text-gray-400 mb-2">{changelog.summary}</p>}
              <ul className="list-disc list-inside text-xs text-gray-400 space-y-0.5">
                {changelog.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {/* Changelog completion form */}
          {showChangelogForm && (
            <div className="mb-5">
              <ChangelogForm
                milestone={milestone}
                onCompleted={() => { setShowChangelogForm(false); loadMilestone(); }}
                onCancel={() => setShowChangelogForm(false)}
                showError={showError}
              />
            </div>
          )}

          {/* Timestamps */}
          <div className="text-xs text-gray-600 mb-5 space-y-0.5">
            <p>{t('common.created')}: {new Date(milestone.createdAt).toLocaleString(locale)}</p>
            {milestone.updatedAt !== milestone.createdAt && (
              <p>{t('common.updated')}: {new Date(milestone.updatedAt).toLocaleString(locale)}</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 mb-8">
            {milestone.status === 'open' && (
              <Button type="button" variant="none" size="sm" className="bg-yellow-900/60 hover:bg-yellow-900 text-yellow-300"
                onClick={() => handleStatusChange('in_progress')}>
                {t('todoTransitions.start')}
              </Button>
            )}
            {milestone.status === 'in_progress' && (
              <>
                <Button type="button" variant="none" size="sm" className="bg-gray-700 hover:bg-gray-600 text-gray-300"
                  onClick={() => handleStatusChange('open')}>
                  {t('milestoneDetail.backToOpen')}
                </Button>
                <Button type="button" variant="none" size="sm" className="bg-green-900/60 hover:bg-green-900 text-green-300"
                  onClick={() => setShowChangelogForm(true)}>
                  {t('milestoneDetail.complete')}
                </Button>
              </>
            )}
            {milestone.status === 'done' && (
              <Button type="button" variant="none" size="sm" className="bg-yellow-900/60 hover:bg-yellow-900 text-yellow-300"
                onClick={() => handleStatusChange('in_progress')}>
                {t('milestoneDetail.reopenMilestone')}
              </Button>
            )}
            <Button type="button" variant="none" size="sm" className="bg-violet-900/60 hover:bg-violet-900 text-cyan-300"
              onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
            <Button type="button" variant="none" size="sm" className="bg-gray-700 hover:bg-gray-600 text-gray-300"
              onClick={async () => {
                try {
                  await api.milestones.update(milestone._id, { archived: !milestone.archived } as Partial<Milestone>);
                  loadMilestone();
                } catch (err: any) {
                  showError(err.message || t('milestoneDetail.archiveFailed'));
                }
              }}>
              {milestone.archived ? t('common.restore') : t('common.archive')}
            </Button>
            <ConfirmButton
              onConfirm={async () => {
                try {
                  await api.milestones.delete(milestoneId!);
                  navigate(`/projects/${id}`);
                } catch (err: any) {
                  showError(err.message || t('milestoneDetail.deleteFailed'));
                }
              }}
              size="sm"
              className="sm:ml-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
}
