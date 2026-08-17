import { useEffect, useState, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Milestone, Todo, ChangelogEntry, ImportResult } from '../api/client';
import Markdown from '../components/Markdown';
import MilestoneForm from '../components/MilestoneForm';
import TodoForm from '../components/TodoForm';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmButton from '../components/ui/ConfirmButton';
import DetailSection from '../components/ui/DetailSection';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { WorkflowModalShell, WorkflowPageShell } from '../components/ui/WorkflowShell';
import MilestoneImportDialog from '../components/milestone/MilestoneImportDialog';
import MilestoneAiCompleteDialog from '../components/milestone/MilestoneAiCompleteDialog';

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
            <Button type="button" size="sm" variant="edit">
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

  return (
    <WorkflowModalShell title={t('todoCreate.title')} onClose={onClose}>
      <TodoForm
        projectId={projectId}
        initialMilestoneId={milestoneId}
        descriptionRows={4}
        submitSize="md"
        className="p-5"
        onCreated={onCreated}
        onCancel={onClose}
      />
    </WorkflowModalShell>
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
      await api.milestones.update(milestone._id, { status: 'done', changelogId: changelog._id });
      onCompleted();
    } catch (err: any) {
      showError(err.message || t('milestoneDetail.completeFailed'));
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm font-medium text-gray-300">{t('milestones.createChangelog')}</p>
      <p className="text-xs text-gray-500">{t('milestoneDetail.changelogRequired')}</p>
      <FormInput
        type="text"
        label={t('common.version')}
        placeholder={t('milestones.versionPlaceholder')}
        value={clVersion}
        onChange={(e) => setClVersion(e.target.value)}
      />
      <FormInput
        type="text"
        label={t('changelog.summary')}
        placeholder={t('milestones.summaryPlaceholder')}
        value={clSummary}
        onChange={(e) => setClSummary(e.target.value)}
      />
      <FormTextarea
        label={t('changelog.changes')}
        placeholder={t('milestones.changesPlaceholder')}
        value={clChanges}
        onChange={(e) => setClChanges(e.target.value)}
        rows={4}
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
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);

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

  const handleExport = async () => {
    if (!milestoneId) return;
    try {
      await api.milestones.exportRaw(milestoneId);
    } catch (err: any) {
      showError(err.message || t('common.error', 'Fehler'));
    }
  };

  const handleImported = (_result: ImportResult) => {
    // Import creates a new milestone in the same project; just close dialog
    setImportDialogOpen(false);
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
    <WorkflowPageShell backTo={`/projects/${id}`} backLabel={t('milestoneDetail.backToProject')}>
      {editing ? (
        <div>
          <h2 className="text-lg font-semibold mb-4">{t('milestoneDetail.editMilestone')}</h2>
          <MilestoneForm
            projectId={id!}
            milestone={milestone}
            submitSize="md"
            onSaved={() => { setEditing(false); loadMilestone(); }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div>
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

          <DetailSection title={t('milestoneDetail.progress')} className="mb-5">
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
          </DetailSection>

          <DetailSection
            title={t('milestoneDetail.tasks')}
            meta={milestoneTodos.length > 0 ? `(${milestoneTodos.length})` : undefined}
            actions={(
              <Button type="button" size="sm" variant="accent" onClick={() => setShowCreateTodo(true)}>
                {t('milestoneDetail.newQuest')}
              </Button>
            )}
            className="mb-5"
          >
            {milestoneTodos.length > 0 ? (
              <div className="space-y-1.5">
                {[...openTodos, ...inProgressTodos, ...reviewTodos, ...doneTodos].map((todo) => (
                  <TodoAccordionItem key={todo._id} todo={todo} projectId={id!} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">{t('milestoneDetail.noTasks')}</p>
            )}
          </DetailSection>

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
            <DetailSection title={t('milestoneDetail.changelog')} className="mb-5">
              {changelog.version && <p className="text-xs text-gray-500 mb-1">{t('common.version')}: {changelog.version}</p>}
              {changelog.summary && (
                <div className="mb-2 text-gray-400">
                  <Markdown>{changelog.summary}</Markdown>
                </div>
              )}
              <ul className="list-disc list-inside text-xs text-gray-400 space-y-0.5">
                {changelog.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </DetailSection>
          )}

          {/* Changelog completion form */}
          {showChangelogForm && (
            <DetailSection className="mb-5">
              <ChangelogForm
                milestone={milestone}
                onCompleted={() => { setShowChangelogForm(false); loadMilestone(); }}
                onCancel={() => setShowChangelogForm(false)}
                showError={showError}
              />
            </DetailSection>
          )}

          {/* Timestamps */}
          <div className="text-xs text-gray-600 mb-5 space-y-0.5">
            <p>{t('common.created')}: {new Date(milestone.createdAt).toLocaleString(locale)}</p>
            {milestone.updatedAt !== milestone.createdAt && (
              <p>{t('common.updated')}: {new Date(milestone.updatedAt).toLocaleString(locale)}</p>
            )}
          </div>

          <DetailSection title={t('common.actions')} className="mb-8">
            <div className="flex flex-wrap items-center gap-2">
            {milestone.status === 'open' && (
              <Button type="button" variant="warning" size="sm" onClick={() => handleStatusChange('in_progress')}>
                {t('todoTransitions.start')}
              </Button>
            )}
            {milestone.status === 'in_progress' && (
              <>
                <Button type="button" variant="neutral" size="sm" onClick={() => handleStatusChange('open')}>
                  {t('milestoneDetail.backToOpen')}
                </Button>
                <Button type="button" variant="success" size="sm" onClick={() => setShowChangelogForm(true)}>
                  {t('milestoneDetail.complete')}
                </Button>
              </>
            )}
            {milestone.status === 'done' && (
              <Button type="button" variant="warning" size="sm" onClick={() => handleStatusChange('in_progress')}>
                {t('milestoneDetail.reopenMilestone')}
              </Button>
            )}
            <Button type="button" variant="edit" size="sm" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
            <Button type="button" variant="neutral" size="sm"
              onClick={async () => {
                try {
                  await api.milestones.update(milestone._id, { archived: !milestone.archived });
                  loadMilestone();
                } catch (err: any) {
                  showError(err.message || t('milestoneDetail.archiveFailed'));
                }
              }}>
              {milestone.archived ? t('common.restore') : t('common.archive')}
            </Button>
            <Button type="button" variant="neutral" size="sm" onClick={handleExport}>
              {t('milestone.actions.exportMarkdown')}
            </Button>
            <Button type="button" variant="neutral" size="sm" onClick={() => setImportDialogOpen(true)}>
              {t('milestone.actions.importMarkdown')}
            </Button>
            <Button type="button" variant="accent" size="sm" onClick={() => setAiDialogOpen(true)}>
              {t('milestone.actions.aiComplete')}
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
          </DetailSection>

          {/* Import Dialog */}
          {id && (
            <MilestoneImportDialog
              open={importDialogOpen}
              projectId={id}
              onClose={() => setImportDialogOpen(false)}
              onImported={handleImported}
            />
          )}

          {/* AI Complete Dialog */}
          {milestoneId && (
            <MilestoneAiCompleteDialog
              open={aiDialogOpen}
              milestoneId={milestoneId}
              onClose={() => setAiDialogOpen(false)}
              onApplied={() => { loadTodos(); loadMilestone(); }}
            />
          )}
        </div>
      )}
    </WorkflowPageShell>
  );
}
