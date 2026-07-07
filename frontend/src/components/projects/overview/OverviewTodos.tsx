import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Todo } from '../../../api/client';
import EmptyState from '../../ui/EmptyState';

const PRIORITY_ORDER: Record<Todo['priority'], number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

// Statische Klassen (keine dynamische String-Konstruktion) — sonst purged
// Tailwind sie weg, da der Content-Scan nur literale Klassen sieht (CLAUDE.md).
const PRIORITY_DOT: Record<Todo['priority'], string> = {
  critical: 'bg-red-400', high: 'bg-orange-400', medium: 'bg-yellow-400', low: 'bg-gray-500',
};

interface Props {
  todos: Todo[];
  projectId: string;
  onViewAll: () => void;
}

export default function OverviewTodos({ todos, projectId, onViewAll }: Props) {
  const { t } = useTranslation();
  const open = todos
    .filter((td) => td.status !== 'done' && !td.archived)
    .sort((a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 5);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">{t('projectDetail.tab.todos')}</h3>
        <button type="button" onClick={onViewAll} className="text-xs text-cyan-400 hover:text-cyan-300">
          {t('projectDetail.overview.viewAll')}
        </button>
      </div>
      {open.length === 0 ? (
        <EmptyState message={t('projectDetail.overview.noOpenTodos')} />
      ) : (
        <ul className="space-y-1.5">
          {open.map((td) => (
            <li key={td._id}>
              <Link
                to={`/projects/${projectId}/todos/${td._id}`}
                className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 group"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[td.priority]}`} />
                {td.displayNumber && <span className="text-xs text-gray-600 font-mono shrink-0">{td.displayNumber}</span>}
                <span className="truncate group-hover:underline">{td.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
