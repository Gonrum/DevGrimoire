import { useTranslation } from 'react-i18next';
import { Milestone, Todo } from '../../../api/client';
import EmptyState from '../../ui/EmptyState';

interface Props {
  milestones: Milestone[];
  todos: Todo[];
  onViewAll: () => void;
}

export default function OverviewMilestones({ milestones, todos, onViewAll }: Props) {
  const { t } = useTranslation();
  const active = milestones.filter((m) => m.status !== 'done' && !m.archived);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">{t('projectDetail.tab.milestones')}</h3>
        <button type="button" onClick={onViewAll} className="text-xs text-cyan-400 hover:text-cyan-300">
          {t('projectDetail.overview.viewAll')}
        </button>
      </div>
      {active.length === 0 ? (
        <EmptyState message={t('projectDetail.overview.noActiveMilestones')} />
      ) : (
        <ul className="space-y-3">
          {active.map((m) => {
            const mTodos = todos.filter((td) => td.milestoneId === m._id);
            const done = mTodos.filter((td) => td.status === 'done').length;
            const donePercent = mTodos.length > 0 ? Math.round((done / mTodos.length) * 100) : 0;
            return (
              <li key={m._id}>
                <div className="flex items-center justify-between text-sm text-gray-300">
                  <span className="truncate">
                    {m.displayNumber && <span className="text-xs text-gray-600 font-mono mr-1">{m.displayNumber}</span>}
                    {m.name}
                  </span>
                  <span className="text-xs text-gray-500 shrink-0 ml-2">{donePercent}%</span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
                  <div className="h-1.5 bg-violet-500 transition-all" style={{ width: `${donePercent}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
