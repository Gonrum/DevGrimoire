import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Question, QuestionDirection } from '../../api/client';
import { wsEventBus, isQuestionEvent } from '../../api/wsEventBus';
import Markdown from '../Markdown';

interface Props {
  /** When set, restrict to this project. Otherwise widget aggregates across all accessible projects. */
  projectId?: string;
  /** Initial direction filter. Default: undefined → both. */
  initialDirection?: QuestionDirection;
  className?: string;
}

const PAGE_SIZE = 8;

/**
 * Dashboard / project widget for open agent↔user questions (M-30 / T-246).
 * Lists pending and expired-unanswered questions with deep-links to the
 * matching todo. Updates after answers via the same endpoint as TodoBoard.
 */
export default function PendingQuestionsWidget({ projectId, initialDirection, className = '' }: Props) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<QuestionDirection | ''>(initialDirection ?? '');
  const [projectsById, setProjectsById] = useState<Record<string, Project>>({});

  useEffect(() => {
    if (projectId) return;
    api.projects.list({ active: true })
      .then((projects) => {
        const map: Record<string, Project> = {};
        for (const p of projects) map[p._id] = p;
        setProjectsById(map);
      })
      .catch(() => setProjectsById({}));
  }, [projectId]);

  const load = () => {
    setLoading(true);
    api.questions
      .open({
        projectId,
        direction: direction || undefined,
        limit: PAGE_SIZE,
      })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => {
        setItems([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Live updates via WS bus — refresh on every question event since either
    // direction (created/answered) changes the pending list.
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (isQuestionEvent(event)) load();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, direction]);

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const remainder = Math.max(0, total - items.length);

  const directionFilter = useMemo(
    () => (
      <div className="flex gap-1 text-[11px]">
        {(['', 'agent_to_user', 'user_to_agent'] as const).map((d) => {
          const active = direction === d;
          const labelKey = d === ''
            ? 'questions.filterDirectionAll'
            : d === 'agent_to_user'
              ? 'questions.filterDirectionAgentToUser'
              : 'questions.filterDirectionUserToAgent';
          return (
            <button
              key={d || 'all'}
              type="button"
              onClick={() => setDirection(d)}
              className={`rounded-full px-2 py-0.5 border transition-colors ${
                active
                  ? 'border-violet-500 bg-violet-900/40 text-violet-200'
                  : 'border-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {t(labelKey)}
            </button>
          );
        })}
      </div>
    ),
    [direction, t],
  );

  return (
    <section
      aria-labelledby="pending-questions-heading"
      className={`bg-gray-900 border border-gray-800 rounded-lg p-4 ${className}`}
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 id="pending-questions-heading" className="text-sm font-semibold text-gray-200">
          <span className="mr-1.5" aria-hidden="true">&#x2753;</span>
          {t('questions.widgetTitle')}
          {total > 0 && <span className="ml-2 text-xs text-violet-300">({total})</span>}
        </h2>
        {directionFilter}
      </div>

      {loading && items.length === 0 ? (
        <p className="text-xs text-gray-600 italic">…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-600 italic">{t('questions.widgetEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((q) => {
            const link = q.todoId
              ? `/projects/${q.projectId}/todos/${q.todoId}`
              : q.projectId
                ? `/projects/${q.projectId}`
                : '#';
            const directionLabel = q.direction === 'user_to_agent'
              ? t('questions.directionUserToAgent')
              : t('questions.directionAgentToUser');
            const directionAccent = q.direction === 'user_to_agent'
              ? 'bg-cyan-900/30 text-cyan-300 border-cyan-800/50'
              : 'bg-violet-900/30 text-violet-200 border-violet-800/50';
            const projectName = q.projectId ? projectsById[q.projectId]?.name : null;

            return (
              <li key={q._id}>
                <Link
                  to={link}
                  className="block rounded border border-gray-800 bg-gray-950/50 px-3 py-2 hover:border-violet-700 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className={`inline-flex items-center text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border ${directionAccent}`}>
                      {directionLabel}
                    </span>
                    <span className="text-[11px] text-gray-600">
                      {new Date(q.createdAt).toLocaleString(dateLocale, {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="text-xs text-gray-200 line-clamp-2">
                    <Markdown>{q.question}</Markdown>
                  </div>
                  {!projectId && projectName && (
                    <div className="mt-1 text-[11px] text-gray-500 truncate">{projectName}</div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {remainder > 0 && (
        <p className="mt-2 text-[11px] text-gray-600">+ {remainder} {t('questions.widgetViewAll')}</p>
      )}
    </section>
  );
}
