import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { Project, Todo } from '../../api/client';
import { pickOpenTodos } from '../../lib/project-detail-view';

const TODO_LIMIT = 8;

// Static class names only — Tailwind purges dynamically built ones.
const PRIORITY_DOT: Record<Todo['priority'], string> = {
  critical: 'bg-red-400', high: 'bg-orange-400', medium: 'bg-yellow-400', low: 'bg-gray-500',
};

interface Props {
  customerId: string;
  customerTodos: Todo[];
  /** Todos of all linked projects (already merged, any status). */
  projectTodos: Todo[];
  projectsById: Map<string, Project>;
  projectTodosLoading: boolean;
  onShowCustomerTodos: () => void;
}

/**
 * Customer overview lead card: the customer's own open quests and the open
 * quests of its linked projects. Empty sections are left out entirely.
 */
export default function CustomerOverviewOpen({
  customerId, customerTodos, projectTodos, projectsById, projectTodosLoading, onShowCustomerTodos,
}: Props) {
  const { t } = useTranslation();
  const own = pickOpenTodos(customerTodos, TODO_LIMIT);
  const linked = pickOpenTodos(projectTodos, TODO_LIMIT);

  const nothingOpen = own.shown.length === 0 && linked.shown.length === 0 && !projectTodosLoading;
  if (nothingOpen) {
    return (
      <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-400">
        <CheckCircle2 className="w-4 h-4 text-green-400" />
        {t('projectDetail.overview.allClear')}
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
      {own.shown.length > 0 && (
        <section className="p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">
              {t('customers.tab.todos')}
              <span className="ml-2 text-xs font-normal text-gray-500">{own.shown.length + own.rest}</span>
            </h3>
            <button type="button" onClick={onShowCustomerTodos} className="text-xs text-cyan-400 hover:text-cyan-300">
              {t('projectDetail.overview.viewAll')}
            </button>
          </div>
          <TodoRows todos={own.shown} hrefFor={(td) => `/customers/${customerId}/todos/${td._id}`} />
          {own.rest > 0 && (
            <button type="button" onClick={onShowCustomerTodos} className="mt-2 text-xs text-cyan-400 hover:text-cyan-300">
              {t('projectDetail.overview.moreTodos', { count: own.rest })}
            </button>
          )}
        </section>
      )}

      {(linked.shown.length > 0 || projectTodosLoading) && (
        <section className="p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">
            {t('customers.projectQuests')}
            {!projectTodosLoading && (
              <span className="ml-2 text-xs font-normal text-gray-500">{linked.shown.length + linked.rest}</span>
            )}
          </h3>
          {projectTodosLoading && linked.shown.length === 0 ? (
            <p className="text-xs text-gray-600 italic">…</p>
          ) : (
            <>
              <TodoRows
                todos={linked.shown}
                hrefFor={(td) => (td.projectId ? `/projects/${td.projectId}/todos/${td._id}` : `/customers/${customerId}/todos/${td._id}`)}
                projectName={(td) => (td.projectId ? projectsById.get(td.projectId)?.name : undefined)}
              />
              {linked.rest > 0 && (
                <p className="mt-2 text-xs text-gray-500">{t('projectDetail.overview.moreTodos', { count: linked.rest })}</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function TodoRows({
  todos, hrefFor, projectName,
}: {
  todos: Todo[];
  hrefFor: (todo: Todo) => string;
  projectName?: (todo: Todo) => string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1.5">
      {todos.map((td) => {
        const project = projectName?.(td);
        return (
          <li key={td._id}>
            <Link to={hrefFor(td)} className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 group">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[td.priority]}`} />
              {td.displayNumber && <span className="text-xs text-gray-600 font-mono shrink-0">{td.displayNumber}</span>}
              <span className="truncate group-hover:underline">{td.title}</span>
              <span className="ml-auto flex items-center gap-2 shrink-0">
                {project && <span className="text-[11px] text-violet-300/80 truncate max-w-40">{project}</span>}
                {td.status !== 'open' && <span className="text-[11px] text-gray-500">{t(`todoStatus.${td.status}`, td.status)}</span>}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
