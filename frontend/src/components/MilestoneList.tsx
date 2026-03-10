import { useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, Milestone, Todo } from '../api/client';
import { useToast } from './Toast';
import Button from './ui/Button';
import Card from './ui/Card';
import Badge from './ui/Badge';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';

const STATUS_LABELS: Record<Milestone['status'], string> = {
  open: 'Offen',
  in_progress: 'In Arbeit',
  done: 'Erledigt',
};

const STATUS_COLORS: Record<Milestone['status'], string> = {
  open: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-yellow-900 text-yellow-300',
  done: 'bg-green-900 text-green-300',
};

interface Props {
  milestones: Milestone[];
  todos: Todo[];
  projectId: string;
  onUpdate: () => void;
}

function MilestoneCard({ milestone, todos, projectId, onUpdate, showError }: { milestone: Milestone; todos: Todo[]; projectId: string; onUpdate: () => void; showError: (msg: string) => void }) {
  const [showChangelogForm, setShowChangelogForm] = useState(false);
  const [clVersion, setClVersion] = useState('');
  const [clSummary, setClSummary] = useState('');
  const [clChanges, setClChanges] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const milestoneTodos = todos.filter((t) => t.milestoneId === milestone._id);
  const doneTodos = milestoneTodos.filter((t) => t.status === 'done');
  const reviewTodos = milestoneTodos.filter((t) => t.status === 'review');
  const total = milestoneTodos.length;
  const donePercent = total > 0 ? Math.round((doneTodos.length / total) * 100) : 0;
  const reviewPercent = total > 0 ? Math.round((reviewTodos.length / total) * 100) : 0;

  const handleStatusChange = async (status: Milestone['status']) => {
    try {
      await api.milestones.update(milestone._id, { status });
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Status-Änderung fehlgeschlagen');
    }
  };

  const handleComplete = async (e: FormEvent) => {
    e.preventDefault();
    const changes = clChanges.split('\n').map((l) => l.trim()).filter(Boolean);
    if (changes.length === 0) {
      showError('Mindestens eine Änderung eintragen.');
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
      setShowChangelogForm(false);
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Abschließen fehlgeschlagen');
    }
    setSubmitting(false);
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold">{milestone.displayNumber && <span className="text-gray-500 font-normal mr-1.5">{milestone.displayNumber}</span>}{milestone.name}</h3>
        <Badge color={STATUS_COLORS[milestone.status]} rounded="full" className="shrink-0">{STATUS_LABELS[milestone.status]}</Badge>
      </div>

      {milestone.description && (
        <p className="text-xs text-gray-500 mb-3">{milestone.description}</p>
      )}

      {milestone.dueDate && (
        <p className="text-xs text-gray-600 mb-2">
          Fällig: {new Date(milestone.dueDate).toLocaleDateString('de-DE')}
        </p>
      )}

      <div className="mb-2">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>
            {doneTodos.length} erledigt
            {reviewTodos.length > 0 && <> · {reviewTodos.length} in Review</>}
            {' '}/ {total} Tasks
          </span>
          <span>{donePercent}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1.5 flex overflow-hidden">
          <div
            className={`h-1.5 transition-all ${donePercent + reviewPercent === 100 && reviewPercent === 0 ? 'bg-green-500' : 'bg-blue-500'}`}
            style={{ width: `${donePercent}%` }}
          />
          {reviewPercent > 0 && (
            <div
              className="h-1.5 bg-purple-500 transition-all"
              style={{ width: `${reviewPercent}%` }}
            />
          )}
        </div>
      </div>

      {milestoneTodos.length > 0 && (
        <div className="mt-3 space-y-1">
          {milestoneTodos.slice(0, 5).map((todo) => (
            <Link key={todo._id} to={`/projects/${projectId}/todos/${todo._id}`}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${todo.status === 'done' ? 'bg-green-500' : todo.status === 'in_progress' ? 'bg-yellow-500' : todo.status === 'review' ? 'bg-purple-500' : 'bg-gray-600'}`} />
              <span className={todo.status === 'done' ? 'line-through text-gray-600' : ''}>{todo.title}</span>
            </Link>
          ))}
          {milestoneTodos.length > 5 && (
            <p className="text-xs text-gray-600">+ {milestoneTodos.length - 5} weitere</p>
          )}
        </div>
      )}

      {showChangelogForm && (
        <form onSubmit={handleComplete} className="mt-3 pt-3 border-t border-gray-800 space-y-2">
          <p className="text-xs font-medium text-gray-400">Changelog-Eintrag erstellen</p>
          <input
            type="text"
            placeholder="Version (z.B. 1.2.0)"
            value={clVersion}
            onChange={(e) => setClVersion(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Zusammenfassung"
            value={clSummary}
            onChange={(e) => setClSummary(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <textarea
            placeholder="Änderungen (eine pro Zeile)"
            value={clChanges}
            onChange={(e) => setClChanges(e.target.value)}
            rows={3}
            className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none resize-none"
            required
          />
          <div className="flex gap-2">
            <Button size="xs" type="submit" disabled={submitting}>
              {submitting ? 'Speichern...' : 'Abschließen'}
            </Button>
            <Button size="xs" type="button" onClick={() => setShowChangelogForm(false)}>Abbrechen</Button>
          </div>
        </form>
      )}

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
        {milestone.status === 'open' && (
          <Button size="xs" onClick={() => handleStatusChange('in_progress')}>Starten</Button>
        )}
        {milestone.status === 'in_progress' && (
          <>
            <Button size="xs" onClick={() => handleStatusChange('open')}>Zurück</Button>
            <Button size="xs" onClick={() => setShowChangelogForm(true)}>Abschließen</Button>
          </>
        )}
        {milestone.status === 'done' && (
          <Button size="xs" onClick={() => handleStatusChange('in_progress')}>Wieder öffnen</Button>
        )}
        <Button size="xs" onClick={async () => {
          try {
            await api.milestones.update(milestone._id, { archived: !milestone.archived } as Partial<Milestone>);
            onUpdate();
          } catch (err: any) {
            showError(err.message || 'Archivierung fehlgeschlagen');
          }
        }}>
          {milestone.archived ? 'Wiederherstellen' : 'Archivieren'}
        </Button>
        <ConfirmButton onConfirm={async () => {
          try {
            await api.milestones.delete(milestone._id);
            onUpdate();
          } catch (err: any) {
            showError(err.message || 'Löschen fehlgeschlagen');
          }
        }} className="ml-auto" />
      </div>
    </Card>
  );
}

export default function MilestoneList({ milestones, todos, projectId, onUpdate }: Props) {
  const { showError } = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const unassignedTodos = todos.filter((t) => !t.milestoneId && t.status !== 'done');

  const isArchived = (ms: Milestone) =>
    ms.archived || (ms.status === 'done' && Date.now() - new Date(ms.updatedAt).getTime() > 24 * 60 * 60 * 1000);
  const archivedCount = milestones.filter(isArchived).length;
  const archivableDone = milestones.filter((ms) => ms.status === 'done' && !ms.archived);
  const visible = showArchived ? milestones : milestones.filter((ms) => !isArchived(ms));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Link to={`/projects/${projectId}/milestones/new`}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Neuer Milestone
        </Link>
        {archivableDone.length > 0 && (
          <button type="button" onBlur={() => setConfirmArchiveAll(false)} onClick={async () => {
            if (!confirmArchiveAll) { setConfirmArchiveAll(true); return; }
            setConfirmArchiveAll(false);
            try {
              await Promise.all(archivableDone.map((ms) => api.milestones.update(ms._id, { archived: true } as Partial<Milestone>)));
              onUpdate();
            } catch (err: any) {
              showError(err.message || 'Archivierung fehlgeschlagen');
            }
          }}
            className={`text-xs px-2 py-1 rounded transition-colors ${confirmArchiveAll ? 'bg-yellow-900/60 text-yellow-300' : 'text-gray-600 hover:text-gray-400'}`}>
            {confirmArchiveAll ? `Sicher? (${archivableDone.length})` : `Erledigte archivieren (${archivableDone.length})`}
          </button>
        )}
        {archivedCount > 0 && (
          <Button size="sm" onClick={() => setShowArchived(!showArchived)}
            className={showArchived ? 'bg-gray-700 text-gray-300' : 'text-gray-600 hover:text-gray-400'}>
            {showArchived ? `Archiv ausblenden (${archivedCount})` : `Archiv (${archivedCount})`}
          </Button>
        )}
      </div>

      {visible.length === 0 && unassignedTodos.length === 0 && (
        <EmptyState message="Noch keine Milestones. Lege einen über das Formular oder per MCP an." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {visible.map((ms) => (
          <MilestoneCard key={ms._id} milestone={ms} todos={todos} projectId={projectId} onUpdate={onUpdate} showError={showError} />
        ))}
      </div>

      {unassignedTodos.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-500 mb-2">
            Nicht zugeordnete Tasks <span className="text-gray-600">({unassignedTodos.length})</span>
          </h3>
          <div className="space-y-1">
            {unassignedTodos.map((todo) => (
              <Link key={todo._id} to={`/projects/${projectId}/todos/${todo._id}`}
                className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${todo.status === 'in_progress' ? 'bg-yellow-500' : todo.status === 'review' ? 'bg-purple-500' : 'bg-gray-600'}`} />
                {todo.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
