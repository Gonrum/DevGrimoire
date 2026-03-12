import { useTranslation } from 'react-i18next';
import { ChangelogEntry } from '../api/client';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';

export default function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  const { t, i18n } = useTranslation();

  if (entries.length === 0) {
    return <EmptyState message={t('changelog.noChangelog')} />;
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => (
        <Card key={e._id}>
          <div className="flex items-center gap-3 mb-2">
            {e.version && (
              <Badge color="bg-violet-900/40 text-cyan-300" className="text-sm font-mono font-semibold">
                v{e.version}
              </Badge>
            )}
            {e.component && (
              <Badge color="bg-purple-900/40 text-purple-300">
                {e.component}
              </Badge>
            )}
            <span className="text-xs text-gray-600 ml-auto">
              {new Date(e.createdAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          {e.summary && (
            <p className="text-sm text-gray-300 mb-2">{e.summary}</p>
          )}
          <ul className="text-sm text-gray-400 space-y-1">
            {e.changes.map((change, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-gray-600 shrink-0">•</span>
                <span>{change}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
