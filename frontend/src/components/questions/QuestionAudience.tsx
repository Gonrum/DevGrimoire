import { useTranslation } from 'react-i18next';
import { Question, QuestionResponse, UserInfo } from '../../api/client';

/**
 * Small badge that summarises who is on the hook for a T-393 question:
 * a single user, a role, an explicit broadcast, or a legacy "everyone".
 * Pass a `usersById` map (from api.users.list) so usernames can be resolved.
 */
export function QuestionAudienceBadge({
  question,
  usersById,
}: {
  question: Question;
  usersById: Record<string, UserInfo>;
}) {
  const { t } = useTranslation();
  const resolved = question.resolvedTargetUserIds ?? [];
  const escalationActive = (question.escalationStep ?? 0) > 0;

  let label: string;
  if (question.targetUserId) {
    const u = usersById[question.targetUserId];
    label = u
      ? t('questions.audienceUser', { username: u.username })
      : t('questions.audienceUserUnknown');
  } else if (question.targetRole) {
    label = t('questions.audienceRole', {
      role: question.targetRole,
      count: resolved.length,
    });
  } else if (question.broadcast) {
    label = t('questions.audienceBroadcast', { count: resolved.length });
  } else if (resolved.length > 0) {
    label = t('questions.audienceResolved', { count: resolved.length });
  } else {
    label = t('questions.audienceLegacy');
  }

  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border bg-gray-800/60 text-gray-300 border-gray-700">
      <span aria-hidden="true">👥</span>
      <span>{label}</span>
      {escalationActive && (
        <span
          title={t('questions.escalationStepTitle', { step: question.escalationStep })}
          className="ml-1 px-1 rounded bg-amber-900/40 text-amber-300 border border-amber-700/50"
        >
          ↑{question.escalationStep}
        </span>
      )}
    </span>
  );
}

/**
 * Lists every captured response with author + timestamp. Used in detail
 * views (Modal, TodoQuestionsSection) so users can see "X answered, Y and
 * Z also responded" instead of only the first answer.
 */
export function QuestionResponsesList({
  responses,
  dateLocale,
}: {
  responses: QuestionResponse[] | undefined;
  dateLocale: string;
}) {
  const { t } = useTranslation();
  if (!responses || responses.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide font-medium text-gray-500">
        {t('questions.responsesHeading', { count: responses.length })}
      </p>
      {responses.map((r, idx) => (
        <div
          key={`${r.userId ?? 'agent'}-${r.at}-${idx}`}
          className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1.5 text-xs"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500 mb-0.5">
            <span>
              {r.byAgent
                ? t('questions.responseByAgent')
                : r.username
                  ? t('questions.responseByUser', { username: r.username })
                  : t('questions.responseByUnknownUser')}
            </span>
            <span>
              {new Date(r.at).toLocaleString(dateLocale, {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
              })}
            </span>
          </div>
          <p className="text-gray-200 whitespace-pre-wrap break-words">{r.answer}</p>
        </div>
      ))}
    </div>
  );
}
