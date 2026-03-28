import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RecurringTask } from '../api/client';
import Badge from './ui/Badge';

const DAY_NAMES_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Props {
  entries: RecurringTask[];
  projectId?: string;
  projectNames?: Record<string, string>;
}

export default function RecurringTaskList({ entries, projectId, projectNames }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const dateFmtLocale = lang === 'de' ? 'de-DE' : 'en-US';
  const isGlobal = !projectId;

  const createLink = projectId
    ? `/projects/${projectId}/recurring-tasks/new`
    : '/recurring-tasks/new';

  const detailLink = (rt: RecurringTask) =>
    rt.projectId
      ? `/projects/${rt.projectId}/recurring-tasks/${rt._id}`
      : `/recurring-tasks/${rt._id}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <Link to={createLink} className="text-sm text-cyan-400 hover:text-cyan-300">
          {t('recurringTasks.newTask')}
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="text-gray-500 text-sm">{t('recurringTasks.noTasks')}</p>
      ) : (
        <div className="space-y-2">
          {entries.map((rt) => {
            const freqLabel = t(`recurringTasks.freq_${rt.frequency}`);
            const dayNames = lang === 'de' ? DAY_NAMES_DE : DAY_NAMES_EN;
            let scheduleDetail = '';
            if ((rt.frequency === 'weekly' || rt.frequency === 'biweekly') && rt.dayOfWeek !== undefined) {
              scheduleDetail = dayNames[rt.dayOfWeek];
            } else if (['monthly', 'quarterly', 'yearly'].includes(rt.frequency) && rt.dayOfMonth) {
              scheduleDetail = `${rt.dayOfMonth}.`;
            }

            return (
              <Link
                key={rt._id}
                to={detailLink(rt)}
                className="block bg-gray-800/50 border border-gray-700 rounded-lg p-3 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rt.active ? 'bg-green-400' : 'bg-gray-600'}`} />
                    <span className="text-sm text-gray-200 truncate">{rt.title}</span>
                    {isGlobal && !rt.projectId && (
                      <Badge color="bg-cyan-900/30 text-cyan-300">{t('recurringTasks.systemWide')}</Badge>
                    )}
                    {isGlobal && rt.projectId && projectNames?.[rt.projectId] && (
                      <span className="text-xs text-gray-500 truncate">{projectNames[rt.projectId]}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge color="bg-violet-900/40 text-violet-300">
                      {freqLabel}{scheduleDetail ? ` (${scheduleDetail})` : ''}
                    </Badge>
                    <span className="text-xs text-gray-500">{`${String(rt.hour).padStart(2, '0')}:00`}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                  <span>
                    {t('recurringTasks.nextRun')}: {new Date(rt.nextRun).toLocaleDateString(dateFmtLocale, { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </span>
                  {rt.lastRun && (
                    <span>
                      {t('recurringTasks.lastRun')}: {new Date(rt.lastRun).toLocaleDateString(dateFmtLocale, { day: '2-digit', month: '2-digit', year: 'numeric' })}
                    </span>
                  )}
                  <span>{rt.createdTodoIds.length} {t('recurringTasks.createdTodos')}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
