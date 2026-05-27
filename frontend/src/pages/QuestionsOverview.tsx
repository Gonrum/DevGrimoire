import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  Project,
  Question,
  QuestionDirection,
  QuestionStatus,
  UserInfo,
} from '../api/client';
import { wsEventBus, isQuestionEvent } from '../api/wsEventBus';
import { useToast } from '../components/Toast';
import Markdown from '../components/Markdown';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { Dialog, Portal } from '../components/ui/Dialog';
import {
  QuestionAudienceBadge,
  QuestionResponsesList,
} from '../components/questions/QuestionAudience';

const STATUS_OPTIONS: QuestionStatus[] = [
  'pending',
  'snoozed',
  'expired',
  'answered',
  'cancelled',
  'superseded',
];
const PAGE_SIZE = 25;

const STATUS_COLORS: Record<QuestionStatus, string> = {
  pending: 'bg-violet-900/40 text-violet-200 border-violet-700/50',
  snoozed: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
  expired: 'bg-amber-900/40 text-amber-400 border-amber-700/50',
  answered: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
  cancelled: 'bg-gray-800 text-gray-500 border-gray-700',
  superseded: 'bg-gray-800 text-gray-400 border-gray-700',
};

export default function QuestionsOverview() {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [items, setItems] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Set<QuestionStatus>>(
    () => new Set<QuestionStatus>(['pending', 'snoozed', 'expired', 'answered']),
  );
  const [directionFilter, setDirectionFilter] = useState<QuestionDirection | ''>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [usersById, setUsersById] = useState<Record<string, UserInfo>>({});
  const [active, setActive] = useState<Question | null>(null);

  const projectsById = useMemo(
    () => Object.fromEntries(projects.map((p) => [p._id, p])),
    [projects],
  );

  useEffect(() => {
    Promise.all([api.projects.list({ active: true }), api.users.list()])
      .then(([projectsResp, usersResp]) => {
        setProjects(projectsResp);
        const map: Record<string, UserInfo> = {};
        for (const u of usersResp) map[u._id] = u;
        setUsersById(map);
      })
      .catch(() => { /* fall through */ });
  }, []);

  const load = () => {
    setLoading(true);
    api.questions
      .listAll({
        status: Array.from(statusFilter),
        direction: directionFilter || undefined,
        projectId: projectFilter || undefined,
        q: q.trim() || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        showError(err instanceof Error ? err.message : t('questions.loadFailed'));
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
  }, [statusFilter, directionFilter, projectFilter, offset]);

  const toggleStatus = (s: QuestionStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
    setOffset(0);
  };

  const onActionDone = (msg: string) => {
    showSuccess(msg);
    setActive(null);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire">
          <span className="mr-2" aria-hidden="true">❓</span>
          {t('questionsPage.title')}
        </h1>
        <span className="text-sm text-gray-500">
          {total > 0
            ? t('questionsPage.totalLabel', { count: total })
            : t('questionsPage.empty')}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            {t('questionsPage.filterStatus')}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTIONS.map((s) => {
              const active = statusFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={`text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border transition ${
                    active
                      ? STATUS_COLORS[s]
                      : 'border-gray-800 text-gray-600 hover:text-gray-400'
                  }`}
                >
                  {t(`questionsPage.status.${s}`)}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            {t('questionsPage.filterDirection')}
          </label>
          <select
            value={directionFilter}
            onChange={(e) => { setDirectionFilter(e.target.value as QuestionDirection | ''); setOffset(0); }}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          >
            <option value="">{t('questions.filterDirectionAll')}</option>
            <option value="agent_to_user">{t('questions.filterDirectionAgentToUser')}</option>
            <option value="user_to_agent">{t('questions.filterDirectionUserToAgent')}</option>
          </select>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            {t('questionsPage.filterProject')}
          </label>
          <select
            value={projectFilter}
            onChange={(e) => { setProjectFilter(e.target.value); setOffset(0); }}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          >
            <option value="">{t('questionsPage.allProjects')}</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            {t('questionsPage.filterSearch')}
          </label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setOffset(0); load(); } }}
            placeholder={t('questionsPage.searchPlaceholder')}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          />
        </div>
      </div>

      {loading ? (
        <LoadingText />
      ) : items.length === 0 ? (
        <EmptyState message={t('questionsPage.empty')} />
      ) : (
        <ul className="space-y-2">
          {items.map((entry) => (
            <li key={entry._id}>
              <button
                type="button"
                onClick={() => setActive(entry)}
                className="w-full text-left block rounded border border-gray-800 bg-gray-900 hover:border-violet-700 transition-colors p-3"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className={`inline-flex items-center text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border ${STATUS_COLORS[entry.status]}`}>
                      {t(`questionsPage.status.${entry.status}`)}
                    </span>
                    <Badge
                      color={entry.direction === 'user_to_agent'
                        ? 'bg-cyan-900/30 text-cyan-300'
                        : 'bg-violet-900/30 text-violet-200'}
                    >
                      {entry.direction === 'user_to_agent'
                        ? t('questions.directionUserToAgent')
                        : t('questions.directionAgentToUser')}
                    </Badge>
                    <QuestionAudienceBadge question={entry} usersById={usersById} />
                  </div>
                  <span className="text-[11px] text-gray-600 shrink-0">
                    {new Date(entry.createdAt).toLocaleString(dateLocale, {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="text-sm text-gray-200 line-clamp-2">
                  <Markdown>{entry.question}</Markdown>
                </div>
                <div className="mt-1 text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                  {entry.projectId && projectsById[entry.projectId] && (
                    <span>{projectsById[entry.projectId].name}</span>
                  )}
                  {entry.agentName && <span>· Agent: {entry.agentName}</span>}
                  {entry.todoId && entry.projectId && (
                    <Link
                      to={`/projects/${entry.projectId}/todos/${entry.todoId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-cyan-500 hover:underline"
                    >
                      → Quest
                    </Link>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← {t('questionsPage.prev')}
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + items.length, total)} / {total}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('questionsPage.next')} →
          </Button>
        </div>
      )}

      {active && (
        <Portal>
          <QuestionDetailDialog
            question={active}
            usersById={usersById}
            dateLocale={dateLocale}
            onClose={() => setActive(null)}
            onDone={onActionDone}
          />
        </Portal>
      )}
    </div>
  );
}

function QuestionDetailDialog({
  question,
  usersById,
  dateLocale,
  onClose,
  onDone,
}: {
  question: Question;
  usersById: Record<string, UserInfo>;
  dateLocale: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [busy, setBusy] = useState(false);
  const [followupTitle, setFollowupTitle] = useState('');
  const [decisionText, setDecisionText] = useState('');
  const [decisionRationale, setDecisionRationale] = useState('');
  const [snoozeHours, setSnoozeHours] = useState('24');

  const canCancel = question.status === 'pending' || question.status === 'snoozed' || question.status === 'expired';
  const canSnooze = question.status === 'pending' || question.status === 'expired';
  const canDeriveTodo = question.status === 'answered' && !question.followupTodoId;
  const canMarkDecision = question.status === 'answered' && !question.decisionKnowledgeId;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={t('questionsPage.detailTitle')} onClose={onClose}>
      <div className="px-5 py-4 space-y-4 max-h-[80vh] overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border ${STATUS_COLORS[question.status]}`}>
            {t(`questionsPage.status.${question.status}`)}
          </span>
          <QuestionAudienceBadge question={question} usersById={usersById} />
          {question.agentName && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-gray-800 text-gray-400">
              Agent: {question.agentName}
            </span>
          )}
        </div>

        {question.context && (
          <div className="text-xs text-gray-500 border-l-2 border-gray-700 pl-2">
            <Markdown>{question.context}</Markdown>
          </div>
        )}
        <div className="text-gray-200">
          <Markdown>{question.question}</Markdown>
        </div>
        <QuestionResponsesList responses={question.responses} dateLocale={dateLocale} />

        {/* Backlinks */}
        <div className="text-[11px] text-gray-500 space-y-1 border-t border-gray-800 pt-3">
          {question.todoId && question.projectId && (
            <div>
              <Link to={`/projects/${question.projectId}/todos/${question.todoId}`} onClick={onClose} className="text-cyan-400 hover:underline">
                → {t('questionsPage.linkTodo')}
              </Link>
            </div>
          )}
          {question.followupTodoId && question.projectId && (
            <div>
              <Link to={`/projects/${question.projectId}/todos/${question.followupTodoId}`} onClick={onClose} className="text-cyan-400 hover:underline">
                → {t('questionsPage.linkFollowup')}
              </Link>
            </div>
          )}
          {question.decisionKnowledgeId && question.projectId && (
            <div>
              <Link to={`/projects/${question.projectId}/knowledge`} onClick={onClose} className="text-cyan-400 hover:underline">
                → {t('questionsPage.linkDecision')}
              </Link>
            </div>
          )}
        </div>

        {/* Lifecycle actions */}
        {(canCancel || canSnooze) && (
          <div className="border-t border-gray-800 pt-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t('questionsPage.lifecycleActions')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {canSnooze && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={snoozeHours}
                    onChange={(e) => setSnoozeHours(e.target.value)}
                    className="w-16 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                  />
                  <span className="text-[11px] text-gray-500">h</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={busy || !snoozeHours}
                    onClick={() => run(async () => {
                      const hours = parseFloat(snoozeHours);
                      if (!Number.isFinite(hours) || hours <= 0) return;
                      const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
                      await api.questions.snooze(question._id, until);
                      onDone(t('questionsPage.snoozedToast'));
                    })}
                  >
                    {t('questionsPage.snooze')}
                  </Button>
                </div>
              )}
              {canCancel && (
                <Button
                  type="button"
                  size="xs"
                  variant="danger"
                  disabled={busy}
                  onClick={() => run(async () => {
                    if (!window.confirm(t('questionsPage.cancelConfirm'))) return;
                    await api.questions.cancel(question._id);
                    onDone(t('questionsPage.cancelledToast'));
                  })}
                >
                  {t('questionsPage.cancel')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Follow-up todo */}
        {canDeriveTodo && (
          <div className="border-t border-gray-800 pt-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t('questionsPage.followupTitle')}</p>
            <input
              type="text"
              value={followupTitle}
              onChange={(e) => setFollowupTitle(e.target.value)}
              placeholder={t('questionsPage.followupTitlePlaceholder')}
              className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
            />
            <Button
              type="button"
              size="xs"
              variant="primary"
              disabled={busy}
              onClick={() => run(async () => {
                await api.questions.createFollowupTodo(question._id, {
                  title: followupTitle.trim() || undefined,
                });
                setFollowupTitle('');
                onDone(t('questionsPage.followupCreatedToast'));
              })}
            >
              {t('questionsPage.createFollowup')}
            </Button>
          </div>
        )}

        {/* Mark as decision */}
        {canMarkDecision && (
          <div className="border-t border-gray-800 pt-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t('questionsPage.decisionTitle')}</p>
            <input
              type="text"
              value={decisionText}
              onChange={(e) => setDecisionText(e.target.value)}
              placeholder={t('questionsPage.decisionPlaceholder')}
              className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
            />
            <textarea
              value={decisionRationale}
              onChange={(e) => setDecisionRationale(e.target.value)}
              rows={2}
              placeholder={t('questionsPage.decisionRationalePlaceholder')}
              className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
            />
            <Button
              type="button"
              size="xs"
              variant="primary"
              disabled={busy || !decisionText.trim()}
              onClick={() => run(async () => {
                await api.questions.markAsDecision(question._id, {
                  decision: decisionText.trim(),
                  rationale: decisionRationale.trim() || undefined,
                });
                setDecisionText('');
                setDecisionRationale('');
                onDone(t('questionsPage.decisionRecordedToast'));
              })}
            >
              {t('questionsPage.recordDecision')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
