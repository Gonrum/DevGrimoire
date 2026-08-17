import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Todo } from '../../api/client';
import DetailSection from '../ui/DetailSection';
import { FormSelect } from '../ui/FormField';

function TodoLinkRow({ todo, projectId, trailing }: { todo: Todo; projectId?: string; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 rounded border border-gray-800 bg-gray-900/40 px-2.5 py-1.5 text-xs">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${todo.status === 'done' ? 'bg-green-500' : todo.status === 'in_progress' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
      <Link to={`/projects/${projectId}/todos/${todo._id}`} className="min-w-0 flex-1 text-gray-400 transition-colors hover:text-cyan-400">
        <span className={`block truncate ${todo.status === 'done' ? 'text-gray-600 line-through' : ''}`}>{todo.title}</span>
      </Link>
      {trailing}
    </div>
  );
}

interface Props {
  todo: Todo;
  allTodos: Todo[];
  projectId?: string;
  onChanged: () => void;
  onError: (message: string) => void;
  className?: string;
}

export default function TodoDependenciesSection({ todo, allTodos, projectId, onChanged, onError, className }: Props) {
  const { t } = useTranslation();

  const blockedBy = (todo.blockedBy || [])
    .map((bid) => allTodos.find((entry) => entry._id === bid))
    .filter(Boolean) as Todo[];
  const blocks = allTodos.filter((entry) => (entry.blockedBy || []).includes(todo._id));
  const availableDeps = allTodos.filter((entry) => entry._id !== todo._id && !(todo.blockedBy || []).includes(entry._id));
  const hasBlockers = blockedBy.some((b) => b.status !== 'done');

  const removeDependency = async (depId: string) => {
    try {
      await api.todos.update(todo._id, {
        blockedBy: (todo.blockedBy || []).filter((b) => b !== depId),
      });
      onChanged();
    } catch (err: any) {
      onError(err?.message || t('todoDetail.removeDependencyFailed'));
    }
  };

  const addDependency = async (depId: string) => {
    if (!depId) return;
    try {
      await api.todos.update(todo._id, {
        blockedBy: [...(todo.blockedBy || []), depId],
      });
      onChanged();
    } catch (err: any) {
      onError(err?.message || t('todoDetail.addDependencyFailed'));
    }
  };

  return (
    <DetailSection title={t('todoDetail.dependencies')} className={className}>
      {hasBlockers && (
        <div className="mb-3 flex items-center gap-1.5 rounded border border-red-900/50 bg-red-900/20 px-2.5 py-1.5 text-xs text-red-400">
          <span>{t('todoDetail.blocked')}</span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs text-gray-600">{t('todoDetail.blockedBy')}</p>
          {blockedBy.length === 0 && <p className="text-xs italic text-gray-700">{t('common.none')}</p>}
          {blockedBy.map((dep) => (
            <TodoLinkRow
              key={dep._id}
              todo={dep}
              projectId={projectId}
              trailing={(
                <button
                  type="button"
                  onClick={() => removeDependency(dep._id)}
                  className="shrink-0 text-gray-600 transition-colors hover:text-red-400"
                  aria-label={t('todoDetail.removeDependencyFailed')}
                >
                  &times;
                </button>
              )}
            />
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-gray-600">{t('todoDetail.blocking')}</p>
          {blocks.length === 0 && <p className="text-xs italic text-gray-700">{t('common.none')}</p>}
          {blocks.map((dep) => (
            <TodoLinkRow key={dep._id} todo={dep} projectId={projectId} />
          ))}
        </div>
      </div>
      {availableDeps.length > 0 && (
        <FormSelect
          fieldClassName="mt-3"
          value=""
          onChange={(e) => addDependency(e.target.value)}
        >
          <option value="">{t('todoDetail.addDependency')}</option>
          {availableDeps.map((entry) => (
            <option key={entry._id} value={entry._id}>{entry.title}</option>
          ))}
        </FormSelect>
      )}
    </DetailSection>
  );
}
