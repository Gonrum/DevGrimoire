import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Sparkles, FileHeart, ChevronRight } from 'lucide-react';
import { Milestone, Todo } from '../../../api/client';
import PendingQuestionsWidget from '../../dashboard/PendingQuestionsWidget';
import { isOpenTodo, pickOpenTodos } from '../../../lib/project-detail-view';
import type { Tab } from '../tabs';

const TODO_LIMIT = 8;

// Static class names only — Tailwind purges dynamically built ones.
const PRIORITY_DOT: Record<Todo['priority'], string> = {
  critical: 'bg-red-400', high: 'bg-orange-400', medium: 'bg-yellow-400', low: 'bg-gray-500',
};

interface Props {
  projectId: string;
  todos: Todo[];
  milestones: Milestone[];
  openOracleCount: number;
  openDocProposalsCount: number;
  onNavigate: (tab: Tab) => void;
}

/**
 * "What is open?" — the one card the overview leads with. Each section only
 * renders when it has content; with nothing open it collapses to one line.
 */
export default function OverviewOpen({
  projectId, todos, milestones, openOracleCount, openDocProposalsCount, onNavigate,
}: Props) {
  const { t } = useTranslation();
  const [questionCount, setQuestionCount] = useState(0);

  const { shown, rest } = pickOpenTodos(todos, TODO_LIMIT);
  const activeMilestones = milestones.filter((m) => m.status !== 'done' && !m.archived);
  const hints: { key: string; tab: Tab; icon: typeof Sparkles; text: string }[] = [];
  if (openOracleCount > 0) hints.push({ key: 'oracle', tab: 'oracle', icon: Sparkles, text: t('projectDetail.overview.oracleHints', { count: openOracleCount }) });
  if (openDocProposalsCount > 0) hints.push({ key: 'docs', tab: 'docs-health', icon: FileHeart, text: t('projectDetail.overview.docProposals', { count: openDocProposalsCount }) });

  const nothingOpen = shown.length === 0 && activeMilestones.length === 0 && hints.length === 0 && questionCount === 0;

  return (
    <div className="space-y-4">
      <PendingQuestionsWidget projectId={projectId} hideWhenEmpty onTotalChange={setQuestionCount} />

      {nothingOpen ? (
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-400">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          {t('projectDetail.overview.allClear')}
        </div>
      ) : (
        (shown.length > 0 || activeMilestones.length > 0 || hints.length > 0) && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {shown.length > 0 && (
              <section className="p-4 sm:p-5">
                <SectionHeader title={t('projectDetail.tab.todos')} count={todos.filter(isOpenTodo).length} onClick={() => onNavigate('todos')} />
                <ul className="space-y-1.5">
                  {shown.map((td) => (
                    <li key={td._id}>
                      <Link
                        to={`/projects/${projectId}/todos/${td._id}`}
                        className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 group"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[td.priority]}`} />
                        {td.displayNumber && <span className="text-xs text-gray-600 font-mono shrink-0">{td.displayNumber}</span>}
                        <span className="truncate group-hover:underline">{td.title}</span>
                        {td.status !== 'open' && (
                          <span className="ml-auto shrink-0 text-[11px] text-gray-500">{t(`todoStatus.${td.status}`, td.status)}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
                {rest > 0 && (
                  <button type="button" onClick={() => onNavigate('todos')} className="mt-2 text-xs text-cyan-400 hover:text-cyan-300">
                    {t('projectDetail.overview.moreTodos', { count: rest })}
                  </button>
                )}
              </section>
            )}

            {activeMilestones.length > 0 && (
              <section className="p-4 sm:p-5">
                <SectionHeader title={t('projectDetail.tab.milestones')} count={activeMilestones.length} onClick={() => onNavigate('milestones')} />
                <ul className="space-y-3">
                  {activeMilestones.map((m) => {
                    const mTodos = todos.filter((td) => td.milestoneId === m._id);
                    const done = mTodos.filter((td) => td.status === 'done').length;
                    const pct = mTodos.length > 0 ? Math.round((done / mTodos.length) * 100) : 0;
                    return (
                      <li key={m._id}>
                        <div className="flex items-center justify-between text-sm text-gray-300">
                          <span className="truncate">
                            {m.displayNumber && <span className="text-xs text-gray-600 font-mono mr-1">{m.displayNumber}</span>}
                            {m.name}
                          </span>
                          <span className="text-xs text-gray-500 shrink-0 ml-2">{done}/{mTodos.length}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
                          <div className="h-1.5 bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {hints.length > 0 && (
              <section className="px-4 sm:px-5 py-2">
                {hints.map((h) => (
                  <button
                    key={h.key}
                    type="button"
                    onClick={() => onNavigate(h.tab)}
                    className="w-full flex items-center gap-2 py-1.5 text-sm text-gray-400 hover:text-gray-200"
                  >
                    <h.icon className="w-4 h-4 text-violet-400" />
                    <span>{h.text}</span>
                    <ChevronRight className="w-4 h-4 ml-auto text-gray-600" />
                  </button>
                ))}
              </section>
            )}
          </div>
        )
      )}
    </div>
  );
}

function SectionHeader({ title, count, onClick }: { title: string; count: number; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold text-gray-300">
        {title} <span className="ml-1 text-xs font-normal text-gray-500">{count}</span>
      </h3>
      <button type="button" onClick={onClick} className="text-xs text-cyan-400 hover:text-cyan-300">
        {t('projectDetail.overview.viewAll')}
      </button>
    </div>
  );
}
