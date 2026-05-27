import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Question, QuestionDirection } from '../../api/client';
import { wsEventBus, isQuestionEvent } from '../../api/wsEventBus';
import Markdown from '../Markdown';
import Button from '../ui/Button';
import { Dialog, Portal } from '../ui/Dialog';
import { useToast } from '../Toast';

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
 * Lists pending and expired-unanswered questions. Click on an agent→user
 * question opens an answer modal; user→agent questions deep-link to the
 * corresponding todo (where the agent's reply will land).
 */
export default function PendingQuestionsWidget({ projectId, initialDirection, className = '' }: Props) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [items, setItems] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<QuestionDirection | ''>(initialDirection ?? '');
  const [projectsById, setProjectsById] = useState<Record<string, Project>>({});
  const [activeQuestion, setActiveQuestion] = useState<Question | null>(null);

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
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (isQuestionEvent(event)) load();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, direction]);

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const remainder = Math.max(0, total - items.length);

  const handleAnswered = async (questionId: string, answer: string): Promise<boolean> => {
    try {
      await api.questions.answer(questionId, answer);
      showSuccess(t('questions.answeredToast'));
      setItems((prev) => prev.filter((q) => q._id !== questionId));
      setActiveQuestion(null);
      return true;
    } catch (err) {
      showError(err instanceof Error ? err.message : t('questions.answerFailed'));
      return false;
    }
  };

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
          {items.map((q) => (
            <li key={q._id}>
              <QuestionRow
                question={q}
                projectName={!projectId && q.projectId ? projectsById[q.projectId]?.name ?? null : null}
                dateLocale={dateLocale}
                onAnswer={() => setActiveQuestion(q)}
              />
            </li>
          ))}
        </ul>
      )}

      {remainder > 0 && (
        <p className="mt-2 text-[11px] text-gray-600">+ {remainder} {t('questions.widgetViewAll')}</p>
      )}

      {activeQuestion && (
        <Portal>
          <AnswerQuestionModal
            question={activeQuestion}
            onSubmit={(answer) => handleAnswered(activeQuestion._id, answer)}
            onClose={() => setActiveQuestion(null)}
          />
        </Portal>
      )}
    </section>
  );
}

function QuestionRow({
  question,
  projectName,
  dateLocale,
  onAnswer,
}: {
  question: Question;
  projectName: string | null;
  dateLocale: string;
  onAnswer: () => void;
}) {
  const { t } = useTranslation();
  const directionLabel = question.direction === 'user_to_agent'
    ? t('questions.directionUserToAgent')
    : t('questions.directionAgentToUser');
  const directionAccent = question.direction === 'user_to_agent'
    ? 'bg-cyan-900/30 text-cyan-300 border-cyan-800/50'
    : 'bg-violet-900/30 text-violet-200 border-violet-800/50';

  const todoLink = question.todoId && question.projectId
    ? `/projects/${question.projectId}/todos/${question.todoId}`
    : null;

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className={`inline-flex items-center text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border ${directionAccent}`}>
          {directionLabel}
        </span>
        <span className="text-[11px] text-gray-600">
          {new Date(question.createdAt).toLocaleString(dateLocale, {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          })}
        </span>
      </div>
      <div className="text-xs text-gray-200 line-clamp-2">
        <Markdown>{question.question}</Markdown>
      </div>
      {projectName && (
        <div className="mt-1 text-[11px] text-gray-500 truncate">{projectName}</div>
      )}
    </>
  );

  // user_to_agent: user kann nicht antworten — Klick navigiert zum Todo,
  // wo der Agent über MCP answert. Wenn keine todoId vorhanden, ist der
  // Eintrag rein informativ.
  if (question.direction === 'user_to_agent') {
    if (todoLink) {
      return (
        <Link
          to={todoLink}
          className="block rounded border border-gray-800 bg-gray-950/50 px-3 py-2 hover:border-violet-700 transition-colors"
        >
          {inner}
        </Link>
      );
    }
    return (
      <div className="rounded border border-gray-800 bg-gray-950/50 px-3 py-2">
        {inner}
      </div>
    );
  }

  // agent_to_user: Klick öffnet Antwort-Modal.
  return (
    <button
      type="button"
      onClick={onAnswer}
      aria-label={t('questions.openAnswerDialog')}
      className="w-full text-left rounded border border-gray-800 bg-gray-950/50 px-3 py-2 hover:border-violet-700 transition-colors"
    >
      {inner}
    </button>
  );
}

function AnswerQuestionModal({
  question,
  onSubmit,
  onClose,
}: {
  question: Question;
  onSubmit: (answer: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const todoLink = question.todoId && question.projectId
    ? `/projects/${question.projectId}/todos/${question.todoId}`
    : null;

  const submit = async (answer: string) => {
    if (!answer.trim()) return;
    setSubmitting(true);
    const ok = await onSubmit(answer.trim());
    if (!ok) setSubmitting(false);
  };

  const isExpired = question.status === 'expired';

  return (
    <Dialog title={t('questions.answerDialogTitle')} onClose={onClose}>
      <div className="px-5 py-4 space-y-3">
        {question.context && (
          <div className="text-xs text-gray-500 border-l-2 border-gray-700 pl-2">
            <Markdown>{question.context}</Markdown>
          </div>
        )}
        <div className="text-gray-200">
          <Markdown>{question.question}</Markdown>
        </div>
        {isExpired && (
          <p className="text-[11px] text-amber-400/70">{t('questions.expiredHint')}</p>
        )}

        {question.options && question.options.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {question.options.map((opt) => (
              <Button
                key={opt}
                type="button"
                variant="primary"
                size="sm"
                disabled={submitting}
                onClick={() => submit(opt)}
              >
                {opt}
              </Button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end pt-1">
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && freeText.trim()) {
                  void submit(freeText);
                }
              }}
              rows={3}
              autoFocus
              placeholder={t('questions.answerPlaceholder')}
              className="flex-1 min-w-0 bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
            />
            <Button
              type="button"
              variant="primary"
              disabled={submitting || !freeText.trim()}
              onClick={() => submit(freeText)}
            >
              {submitting ? '...' : t('questions.answerSubmit')}
            </Button>
          </div>
        )}

        {todoLink && (
          <div className="pt-2 border-t border-gray-800">
            <Link
              to={todoLink}
              onClick={onClose}
              className="text-xs text-cyan-400 hover:underline"
            >
              {t('questions.openInTodo')} →
            </Link>
          </div>
        )}
      </div>
    </Dialog>
  );
}
