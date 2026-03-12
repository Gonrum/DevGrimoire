import { useTranslation } from 'react-i18next';
import { ResearchEntry } from '../api/client';
import Markdown from './Markdown';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';

export default function ResearchList({ entries }: { entries: ResearchEntry[] }) {
  const { t, i18n } = useTranslation();

  if (entries.length === 0) {
    return <EmptyState message={t('research.noResearch')} />;
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => (
        <Card key={e._id}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">{e.title}</h3>
            <span className="text-xs text-gray-600">
              {new Date(e.updatedAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US')}
            </span>
          </div>
          <Markdown className="text-gray-400">{e.content}</Markdown>
          {e.sources.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-xs text-gray-500 mb-1">{t('research.sources')}</p>
              <ul className="space-y-0.5">
                {e.sources.map((src, i) => (
                  <li key={i} className="text-xs text-blue-400 truncate">
                    {src.startsWith('http') ? (
                      <a href={src} target="_blank" rel="noopener noreferrer" className="hover:underline">{src}</a>
                    ) : (
                      src
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {e.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {e.tags.map((tag) => (
                <Badge key={tag} color="bg-teal-900/40 text-teal-300">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
