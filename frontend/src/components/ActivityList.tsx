import { Activity } from '../api/client';

const ENTITY_ICONS: Record<string, string> = {
  todo: '\u2611',
  milestone: '\u{1F3AF}',
  session: '\u{1F4DD}',
  knowledge: '\u{1F4A1}',
  changelog: '\u{1F4CB}',
  project: '\u2699',
};

const ACTION_COLORS: Record<string, string> = {
  created: 'text-green-400',
  updated: 'text-blue-400',
  deleted: 'text-red-400',
};

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `vor ${diffHours} Std.`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `vor ${diffDays} Tag${diffDays > 1 ? 'en' : ''}`;
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function ActivityList({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <p className="text-gray-500 text-sm">Noch keine Aktivitäten.</p>;
  }

  return (
    <div className="space-y-1">
      {activities.map((a) => (
        <div key={a._id} className="flex items-start gap-3 py-2 border-b border-gray-800/50">
          <span className="text-sm mt-0.5 shrink-0" title={a.entity}>
            {ENTITY_ICONS[a.entity] || '\u25CF'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-300">
              {a.summary || `${a.entity} ${a.action}`}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-xs ${ACTION_COLORS[a.action] || 'text-gray-500'}`}>
                {a.action}
              </span>
              {a.username && (
                <span className="text-xs text-gray-500">{a.username}</span>
              )}
              <span className="text-xs text-gray-600">
                {formatTime(a.createdAt)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
