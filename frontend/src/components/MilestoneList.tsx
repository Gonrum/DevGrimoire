import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Milestone, Todo } from '../api/client';
import { useToast } from './Toast';

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
  const [deleting, setDeleting] = useState(false);
  const milestoneTodos = todos.filter((t) => t.milestoneId === milestone._id);
  const doneTodos = milestoneTodos.filter((t) => t.status === 'done');
  const progress = milestoneTodos.length > 0 ? Math.round((doneTodos.length / milestoneTodos.length) * 100) : 0;

  const handleStatusChange = async (status: Milestone['status']) => {
    try {
      await api.milestones.update(milestone._id, { status });
      onUpdate();
    } catch (err: any) {
      showError(err.message || 'Status-Änderung fehlgeschlagen');
    }
  };

  const handleDelete = async () => {
    if (deleting) {
      try {
        await api.milestones.delete(milestone._id);
        onUpdate();
      } catch (err: any) {
        showError(err.message || 'Löschen fehlgeschlagen');
      }
    } else {
      setDeleting(true);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold">{milestone.name}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[milestone.status]}`}>
          {STATUS_LABELS[milestone.status]}
        </span>
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
          <span>{doneTodos.length} / {milestoneTodos.length} Tasks</span>
          <span>{progress}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all ${progress === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {milestoneTodos.length > 0 && (
        <div className="mt-3 space-y-1">
          {milestoneTodos.slice(0, 5).map((todo) => (
            <Link key={todo._id} to={`/projects/${projectId}/todos/${todo._id}`}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${todo.status === 'done' ? 'bg-green-500' : todo.status === 'in_progress' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
              <span className={todo.status === 'done' ? 'line-through text-gray-600' : ''}>{todo.title}</span>
            </Link>
          ))}
          {milestoneTodos.length > 5 && (
            <p className="text-xs text-gray-600">+ {milestoneTodos.length - 5} weitere</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
        {milestone.status === 'open' && (
          <button type="button" onClick={() => handleStatusChange('in_progress')}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
            Starten
          </button>
        )}
        {milestone.status === 'in_progress' && (
          <>
            <button type="button" onClick={() => handleStatusChange('open')}
              className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
              Zurück
            </button>
            <button type="button" onClick={() => handleStatusChange('done')}
              className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
              Abschließen
            </button>
          </>
        )}
        {milestone.status === 'done' && (
          <button type="button" onClick={() => handleStatusChange('in_progress')}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
            Wieder öffnen
          </button>
        )}
        <button type="button" onClick={async () => {
          try {
            await api.milestones.update(milestone._id, { archived: !milestone.archived } as Partial<Milestone>);
            onUpdate();
          } catch (err: any) {
            showError(err.message || 'Archivierung fehlgeschlagen');
          }
        }}
          className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
          {milestone.archived ? 'Wiederherstellen' : 'Archivieren'}
        </button>
        <button type="button" onClick={handleDelete} onBlur={() => setDeleting(false)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ml-auto ${deleting ? 'bg-red-900 text-red-300 hover:bg-red-800' : 'bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-red-400'}`}>
          {deleting ? 'Sicher?' : 'Löschen'}
        </button>
      </div>
    </div>
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
          <button type="button" onClick={() => setShowArchived(!showArchived)}
            className={`text-xs px-2 py-1 rounded transition-colors ${showArchived ? 'bg-gray-700 text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}>
            {showArchived ? `Archiv ausblenden (${archivedCount})` : `Archiv (${archivedCount})`}
          </button>
        )}
      </div>

      {visible.length === 0 && unassignedTodos.length === 0 && (
        <p className="text-gray-500 text-sm">Noch keine Milestones. Lege einen über das Formular oder per MCP an.</p>
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
