import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Activity, TodoComment, Question } from '../../api/client';
import { ENTITY_ICONS, ACTION_COLORS } from '../../constants/colors';
import i18n from '../../i18n';

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return i18n.t('activity.justNow');
  if (diffMin < 60) return i18n.t('activity.minutesAgo', { count: diffMin });
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return i18n.t('activity.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return i18n.t('activity.daysAgo', { count: diffDays });
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  return date.toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

type TimelineEntryType =
  | 'activity'
  | 'comment'
  | 'question_created'
  | 'question_answered'
  | 'knowledge_created';

const SORT_RANK: Record<TimelineEntryType, number> = {
  question_created: 1,
  comment: 2,
  question_answered: 3,
  knowledge_created: 4,
  activity: 5,
};

interface TimelineEntry {
  id: string;
  type: TimelineEntryType;
  timestamp: string;
  sortRank: number;
  label: string;
  subLabel?: string;
  author?: string;
  action?: string;
  entity?: string;
}

interface Props {
  todoId: string;
  projectId?: string;
  comments: TodoComment[];
  questions: Question[];
}

export default function TodoActivityTimeline({ todoId, projectId, comments, questions }: Props) {
  const { t } = useTranslation();
  const [activities, setActivities] = useState<Activity[]>([]);

  useEffect(() => {
    if (!projectId) return;
    api.activities
      .list(projectId, { entityType: 'todo', entityId: todoId, limit: 100 })
      .then(setActivities)
      .catch(() => setActivities([]));
  }, [projectId, todoId]);

  // Build unified timeline entries
  const entries: TimelineEntry[] = [];

  // 1. Activity events from backend
  for (const a of activities) {
    entries.push({
      id: `act-${a._id}`,
      type: 'activity',
      sortRank: SORT_RANK['activity'],
      timestamp: a.createdAt,
      label: a.summary || `${a.entity} ${a.action}`,
      author: a.username,
      action: a.action,
      entity: a.entity,
    });
  }

  // 2. Comment events from todo.comments
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    entries.push({
      id: `comment-${i}-${c.createdAt}`,
      type: 'comment',
      sortRank: SORT_RANK['comment'],
      timestamp: c.createdAt,
      label: t('todoDetail.activities.event.commentAdded', { author: c.author }),
      subLabel: c.text.length > 120 ? `${c.text.slice(0, 120)}…` : c.text,
      author: c.author,
    });
  }

  // 3. Synthetic question events
  for (const q of questions) {
    entries.push({
      id: `q-created-${q._id}`,
      type: 'question_created',
      sortRank: SORT_RANK['question_created'],
      timestamp: q.createdAt,
      label: t('todoDetail.activities.event.questionCreated'),
      subLabel: q.question.length > 100 ? `${q.question.slice(0, 100)}…` : q.question,
    });

    if (q.answeredAt) {
      entries.push({
        id: `q-answered-${q._id}`,
        type: 'question_answered',
        sortRank: SORT_RANK['question_answered'],
        timestamp: q.answeredAt,
        label: t('todoDetail.activities.event.questionAnswered'),
        author: q.answeredByAgent ? q.agentName : undefined,
      });

      if (q.knowledgeId) {
        entries.push({
          id: `q-knowledge-${q._id}`,
          type: 'knowledge_created',
          sortRank: SORT_RANK['knowledge_created'],
          timestamp: q.answeredAt,
          label: t('todoDetail.activities.event.knowledgeCreated'),
          subLabel: t('todoDetail.activities.event.knowledgeCreatedDetail'),
        });
      }
    }
  }

  // Sort newest first; use sortRank as deterministic tiebreaker for identical timestamps
  entries.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() ||
      b.sortRank - a.sortRank,
  );

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <span className="text-2xl mb-2">📋</span>
        <p className="text-sm text-gray-500">{t('todoDetail.activities.noEvents')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {entries.map((entry) => {
        const icon = getEntryIcon(entry);
        const actionColor = entry.action ? (ACTION_COLORS[entry.action] || 'text-gray-500') : typeColor(entry.type);

        return (
          <div key={entry.id} className="flex items-start gap-3 py-2.5 border-b border-gray-800/50">
            <span className="text-sm mt-0.5 shrink-0" title={entry.type}>
              {icon}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-300">{entry.label}</p>
              {entry.subLabel && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{entry.subLabel}</p>
              )}
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-xs ${actionColor}`}>
                  {entryTypeLabel(entry.type, t)}
                </span>
                {entry.author && (
                  <span className="text-xs text-gray-500">{entry.author}</span>
                )}
                <span className="text-xs text-gray-600">{formatTime(entry.timestamp)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getEntryIcon(entry: TimelineEntry): string {
  if (entry.type === 'activity' && entry.entity) {
    return ENTITY_ICONS[entry.entity] || '●';
  }
  switch (entry.type) {
    case 'comment': return '💬';
    case 'question_created': return '❓';
    case 'question_answered': return '✅';
    case 'knowledge_created': return ENTITY_ICONS['knowledge'] || '💡';
    default: return '●';
  }
}

function typeColor(type: TimelineEntryType): string {
  switch (type) {
    case 'comment': return 'text-blue-400';
    case 'question_created': return 'text-yellow-400';
    case 'question_answered': return 'text-green-400';
    case 'knowledge_created': return 'text-purple-400';
    default: return 'text-gray-500';
  }
}

function entryTypeLabel(type: TimelineEntryType, t: (key: string) => string): string {
  switch (type) {
    case 'activity': return t('todoDetail.activities.typeLabel.activity');
    case 'comment': return t('todoDetail.activities.typeLabel.comment');
    case 'question_created': return t('todoDetail.activities.typeLabel.question');
    case 'question_answered': return t('todoDetail.activities.typeLabel.answer');
    case 'knowledge_created': return t('todoDetail.activities.typeLabel.knowledge');
    default: return type;
  }
}
